//! The routes, called directly, without a network.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use opentelemetry::global::BoxedTracer;
use opentelemetry::metrics::MeterProvider;
use opentelemetry::trace::{SpanKind, TracerProvider};
use opentelemetry_sdk::metrics::{InMemoryMetricExporter, PeriodicReader, SdkMeterProvider};
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
use serde_json::Value;
use service::app::router;
use service::logs::Captured;
use service::telemetry::HttpTelemetry;
use tower::ServiceExt;

const TRACE_ID: &str = "4bf92f3577b34da6a3ce929d0e0e4736";
const CALLER_SPAN_ID: &str = "00f067aa0ba902b7";

/// The service, with what it traces and measures kept in memory, to look at.
struct Sent {
    spans: InMemorySpanExporter,
    tracer_provider: SdkTracerProvider,
    metrics: InMemoryMetricExporter,
    meter_provider: SdkMeterProvider,
}

fn service(cors_origins: &[&str]) -> (Router, Sent) {
    opentelemetry::global::set_text_map_propagator(TraceContextPropagator::new());
    let spans = InMemorySpanExporter::default();
    let tracer_provider = SdkTracerProvider::builder().with_simple_exporter(spans.clone()).build();
    let metrics = InMemoryMetricExporter::default();
    let meter_provider = SdkMeterProvider::builder()
        .with_reader(PeriodicReader::builder(metrics.clone()).build())
        .build();
    let telemetry = HttpTelemetry::new(
        BoxedTracer::new(Box::new(tracer_provider.tracer("test"))),
        &meter_provider.meter("test"),
    );
    let origins: Vec<String> = cors_origins.iter().map(|origin| (*origin).to_owned()).collect();
    (
        router(&origins, Arc::new(telemetry)),
        Sent {
            spans,
            tracer_provider,
            metrics,
            meter_provider,
        },
    )
}

impl Sent {
    fn spans(&self) -> Vec<opentelemetry_sdk::trace::SpanData> {
        self.tracer_provider.force_flush().unwrap();
        self.spans.get_finished_spans().unwrap()
    }

    /// The metrics, as text, which is enough to see what was measured.
    fn metrics(&self) -> String {
        self.meter_provider.force_flush().unwrap();
        format!("{:?}", self.metrics.get_finished_metrics().unwrap())
    }
}

async fn get(app: &Router, uri: &str, headers: &[(&str, &str)]) -> (StatusCode, axum::http::HeaderMap, Value) {
    send(app, "GET", uri, headers).await
}

async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let mut request = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = app.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
    let (parts, body) = response.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    (
        parts.status,
        parts.headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn answers_the_platforms_health_checks_without_logging_tracing_or_measuring_them() {
    let (app, sent) = service(&[]);
    let (logs, _guard) = Captured::start();
    for path in ["/health/live", "/health/ready"] {
        let (status, _, body) = get(&app, path, &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, serde_json::json!({ "status": "ok" }));
    }
    assert!(logs.lines().is_empty());
    assert!(sent.spans().is_empty());
    assert!(!sent.metrics().contains("http.server.request.duration"));
}

#[tokio::test]
async fn answers_a_ping_and_logs_it() {
    let (app, _sent) = service(&[]);
    let (logs, _guard) = Captured::start();
    let (status, _, body) = get(&app, "/api/ping", &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
    assert!(humantime::parse_rfc3339(body["time"].as_str().unwrap()).is_ok());
    let lines = logs.lines();
    assert_eq!(lines[0]["msg"], "Ping received");
    assert_eq!(lines[1]["msg"], "request completed");
    assert_eq!(lines[1]["path"], "/api/ping");
    assert_eq!(lines[1]["status"], 200);
}

#[tokio::test]
async fn greets_by_name_or_the_world() {
    let (app, _sent) = service(&[]);
    let (logs, _guard) = Captured::start();
    assert_eq!(get(&app, "/api/hello?name=Ada", &[]).await.2["message"], "Hello, Ada!");
    assert_eq!(
        get(&app, "/api/hello?name=Jos%C3%A9", &[]).await.2["message"],
        "Hello, José!"
    );
    assert_eq!(get(&app, "/api/hello", &[]).await.2["message"], "Hello, world!");
    assert_eq!(logs.lines()[0]["greeted"], "Ada");
}

#[tokio::test]
async fn refuses_a_name_that_is_empty_too_long_or_given_twice() {
    let (app, _sent) = service(&[]);
    let long = format!("/api/hello?name={}", "x".repeat(101));
    for uri in ["/api/hello?name=", long.as_str(), "/api/hello?name=Ada&name=Alan"] {
        let (status, _, body) = get(&app, uri, &[]).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
        assert_eq!(body["error"], "name must be between 1 and 100 characters.");
    }
    // 100 characters, of two bytes each.
    let longest = format!("/api/hello?name={}", "%C3%A9".repeat(100));
    assert_eq!(get(&app, &longest, &[]).await.0, StatusCode::OK);
}

#[tokio::test]
async fn answers_404_for_a_route_it_does_not_have() {
    let (app, _sent) = service(&[]);
    let (status, _, body) = get(&app, "/api/nothing", &[]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "Not found.");
}

#[tokio::test]
async fn continues_the_trace_a_caller_started() {
    let (app, sent) = service(&[]);
    let (logs, _guard) = Captured::start();
    let traceparent = format!("00-{TRACE_ID}-{CALLER_SPAN_ID}-01");
    get(&app, "/api/ping", &[("traceparent", &traceparent)]).await;
    let spans = sent.spans();
    assert_eq!(spans.len(), 1);
    let span = &spans[0];
    assert_eq!(span.name, "GET /api/ping");
    assert_eq!(span.span_kind, SpanKind::Server);
    assert_eq!(span.span_context.trace_id().to_string(), TRACE_ID);
    assert_eq!(span.parent_span_id.to_string(), CALLER_SPAN_ID);
    let attributes = format!("{:?}", span.attributes);
    assert!(
        attributes.contains("http.response.status_code") && attributes.contains("200"),
        "{attributes}"
    );
    for line in logs.lines() {
        assert_eq!(line["trace_id"], TRACE_ID);
        assert_eq!(line["span_id"], span.span_context.span_id().to_string());
    }
}

#[tokio::test]
async fn measures_each_request_with_its_route_and_status() {
    let (app, sent) = service(&[]);
    get(&app, "/api/hello?name=", &[]).await;
    let metrics = sent.metrics();
    assert!(metrics.contains("http.server.request.duration"), "{metrics}");
    assert!(
        metrics.contains("http.response.status_code") && metrics.contains("400"),
        "{metrics}"
    );
    assert!(metrics.contains("/api/hello"), "{metrics}");
}

#[tokio::test]
async fn lets_the_web_pages_it_lists_call_it_and_send_their_trace() {
    let (app, _sent) = service(&["https://shop.example.com"]);
    let (status, headers, _) = send(
        &app,
        "OPTIONS",
        "/api/ping",
        &[
            ("origin", "https://shop.example.com"),
            ("access-control-request-method", "GET"),
            ("access-control-request-headers", "traceparent"),
        ],
    )
    .await;
    assert!(status.is_success());
    assert_eq!(headers["access-control-allow-origin"], "https://shop.example.com");
    assert!(headers["access-control-allow-headers"]
        .to_str()
        .unwrap()
        .contains("traceparent"));
    let (_, headers, _) = get(&app, "/api/ping", &[("origin", "https://shop.example.com")]).await;
    assert_eq!(headers["access-control-allow-origin"], "https://shop.example.com");
}

#[tokio::test]
async fn lets_no_other_web_page_call_it() {
    let (app, _sent) = service(&["https://shop.example.com"]);
    let (_, headers, _) = get(&app, "/api/ping", &[("origin", "https://evil.example.com")]).await;
    assert!(headers.get("access-control-allow-origin").is_none());
    let (app, _sent) = service(&[]);
    let (_, headers, _) = get(&app, "/api/ping", &[("origin", "https://shop.example.com")]).await;
    assert!(headers.get("access-control-allow-origin").is_none());
}
