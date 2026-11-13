//! The service's routes, on Axum.

use std::any::Any;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use axum::extract::{MatchedPath, Query, Request, State};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use axum::http::{HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use opentelemetry::context::FutureExt;
use opentelemetry_http::HeaderExtractor;
use serde_json::{json, Value};
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::logs::timestamp;
use crate::telemetry::HttpTelemetry;

/// Builds the service without starting it, so tests can call it directly.
pub fn router(cors_origins: &[String], telemetry: Arc<HttpTelemetry>) -> Router {
    let app = Router::new()
        // The platform checks these every few seconds to decide whether to restart the service
        // or send it traffic. They aren't logged or measured, so those show real traffic.
        .route("/health/live", get(healthy))
        .route("/health/ready", get(healthy))
        .route("/api/ping", get(ping))
        .route("/api/hello", get(hello))
        .fallback(not_found)
        // Anything a route panics with is logged, within its request, and answered without its details.
        .layer(CatchPanicLayer::custom(failed))
        .layer(middleware::from_fn_with_state(telemetry, observe));
    if cors_origins.is_empty() {
        return app;
    }
    app.layer(cross_origin(cors_origins))
}

async fn healthy() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

/// Answers without doing anything, to check the service can be reached, and logs that it was.
async fn ping() -> Json<Value> {
    tracing::info!("Ping received");
    Json(json!({ "status": "ok", "time": timestamp(SystemTime::now()) }))
}

async fn hello(Query(query): Query<Vec<(String, String)>>) -> Response {
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
    Json(json!({ "message": format!("Hello, {name}!") })).into_response()
}

async fn not_found() -> Response {
    problem(StatusCode::NOT_FOUND, "Not found.")
}

fn failed(panic: Box<dyn Any + Send + 'static>) -> Response {
    let detail = panic
        .downcast_ref::<&str>()
        .map(|text| (*text).to_owned())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_default();
    tracing::error!(error = %detail, "Request failed");
    problem(StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong.")
}

fn problem(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({ "error": error }))).into_response()
}

/// Traces, measures and logs each request, within the trace a caller started, if it did.
async fn observe(State(telemetry): State<Arc<HttpTelemetry>>, request: Request, next: Next) -> Response {
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|route| route.as_str().to_owned())
        .unwrap_or_default();
    let path = request.uri().path().to_owned();
    let method = request.method().to_string();
    let Some(observed) = telemetry.start(&method, &route, &path, &HeaderExtractor(request.headers())) else {
        return next.run(request).await;
    };
    let response = next.run(request).with_context(observed.context()).await;
    observed.finish(response.status().as_u16());
    response
}

/// Headers browsers may send across origins, including the trace a page started.
const CORS_HEADERS: [HeaderName; 4] = [
    CONTENT_TYPE,
    AUTHORIZATION,
    HeaderName::from_static("traceparent"),
    HeaderName::from_static("tracestate"),
];

/// Lets web pages at these origins call the service from browsers, and send the trace they
/// started, so a request from a page and its work here are one trace.
fn cross_origin(origins: &[String]) -> CorsLayer {
    // The settings only hold valid origins, which are valid header values.
    let origins = origins.iter().filter_map(|origin| HeaderValue::from_str(origin).ok());
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE])
        .allow_headers(CORS_HEADERS)
        .max_age(Duration::from_secs(600))
}
