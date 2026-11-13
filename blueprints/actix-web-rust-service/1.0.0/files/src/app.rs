//! The service's routes, on Actix Web.

use std::time::SystemTime;

use actix_cors::Cors;
use actix_web::body::MessageBody;
use actix_web::dev::{ServiceFactory, ServiceRequest, ServiceResponse};
use actix_web::http::header::{self, HeaderMap};
use actix_web::http::StatusCode;
use actix_web::middleware::{from_fn, Condition, Next};
use actix_web::{web, App, Error, HttpResponse};
use opentelemetry::context::FutureExt;
use opentelemetry::propagation::Extractor;
use serde_json::json;

use crate::logs::timestamp;
use crate::telemetry::HttpTelemetry;

/// Builds the service without starting it, so tests can call it directly.
pub fn app(
    cors_origins: &[String],
    telemetry: web::Data<HttpTelemetry>,
) -> App<
    impl ServiceFactory<
        ServiceRequest,
        Config = (),
        Response = ServiceResponse<impl MessageBody>,
        Error = Error,
        InitError = (),
    >,
> {
    App::new()
        .app_data(telemetry)
        .wrap(from_fn(observe))
        .wrap(Condition::new(!cors_origins.is_empty(), cross_origin(cors_origins)))
        // The platform checks these every few seconds to decide whether to restart the service
        // or send it traffic. They aren't logged or measured, so those show real traffic.
        .route("/health/live", web::get().to(healthy))
        .route("/health/ready", web::get().to(healthy))
        .route("/api/ping", web::get().to(ping))
        .route("/api/hello", web::get().to(hello))
        .default_service(web::to(not_found))
}

async fn healthy() -> HttpResponse {
    HttpResponse::Ok().json(json!({ "status": "ok" }))
}

/// Answers without doing anything, to check the service can be reached, and logs that it was.
async fn ping() -> HttpResponse {
    tracing::info!("Ping received");
    HttpResponse::Ok().json(json!({ "status": "ok", "time": timestamp(SystemTime::now()) }))
}

async fn hello(query: web::Query<Vec<(String, String)>>) -> HttpResponse {
    let names: Vec<&str> = query
        .iter()
        .filter(|(key, _)| key == "name")
        .map(|(_, value)| value.as_str())
        .collect();
    let name = match names.as_slice() {
        [] => "world",
        [name] if (1..=100).contains(&name.chars().count()) => name,
        _ => return problem(StatusCode::BAD_REQUEST, "name must be between 1 and 100 characters."),
    };
    tracing::info!(greeted = %name, "Greeting sent");
    HttpResponse::Ok().json(json!({ "message": format!("Hello, {name}!") }))
}

async fn not_found() -> HttpResponse {
    problem(StatusCode::NOT_FOUND, "Not found.")
}

fn problem(status: StatusCode, error: &str) -> HttpResponse {
    HttpResponse::build(status).json(json!({ "error": error }))
}

/// Traces, measures and logs each request, within the trace a caller started, if it did.
async fn observe(
    request: ServiceRequest,
    next: Next<impl MessageBody>,
) -> Result<ServiceResponse<impl MessageBody>, Error> {
    let telemetry = request.app_data::<web::Data<HttpTelemetry>>().cloned();
    let route = request.match_pattern().unwrap_or_default();
    let path = request.path().to_owned();
    let method = request.method().to_string();
    let observed = telemetry
        .as_deref()
        .and_then(|telemetry| telemetry.start(&method, &route, &path, &Headers(request.headers())));
    let Some(observed) = observed else {
        return next.call(request).await;
    };
    let response = next.call(request).with_context(observed.context()).await;
    let status = match &response {
        Ok(response) => response.status(),
        Err(error) => error.as_response_error().status_code(),
    };
    observed.finish(status.as_u16());
    response
}

/// Where the trace a caller started is read from.
struct Headers<'a>(&'a HeaderMap);

impl Extractor for Headers<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|value| value.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(header::HeaderName::as_str).collect()
    }
}

/// Lets web pages at these origins call the service from browsers, and send the trace they
/// started, so a request from a page and its work here are one trace.
fn cross_origin(origins: &[String]) -> Cors {
    origins
        .iter()
        .fold(Cors::default(), |cors, origin| cors.allowed_origin(origin))
        .allowed_methods(["GET", "POST", "PUT", "PATCH", "DELETE"])
        // Headers browsers may send across origins, including the trace a page started.
        .allowed_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
        .allowed_headers(["traceparent", "tracestate"])
        // A page at another origin gets no permission, rather than an error, as servers that
        // call the service may send an Origin header too.
        .block_on_origin_mismatch(false)
        .max_age(600)
}
