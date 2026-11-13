//! The routes, called directly, without a network.

use actix_web::http::header::HeaderMap;
use actix_web::http::StatusCode;
use actix_web::test::{call_service, init_service, read_body, TestRequest};
use actix_web::web;
use opentelemetry::global::BoxedTracer;
use opentelemetry::metrics::MeterProvider;
use opentelemetry::trace::{SpanKind, TracerProvider};
use opentelemetry_sdk::metrics::{InMemoryMetricExporter, PeriodicReader, SdkMeterProvider};
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
use serde_json::Value;
use service::app::app;
use service::logs::Captured;
use service::telemetry::HttpTelemetry;

const TRACE_ID: &str = "4bf92f3577b34da6a3ce929d0e0e4736";
const CALLER_SPAN_ID: &str = "00f067aa0ba902b7";

/// What the service traces and measures, kept in memory, to look at.
struct Sent {
    spans: InMemorySpanExporter,
    tracer_provider: SdkTracerProvider,
    metrics: InMemoryMetricExporter,
    meter_provider: SdkMeterProvider,
}

impl Sent {
    fn new() -> Self {
        opentelemetry::global::set_text_map_propagator(TraceContextPropagator::new());
        let spans = InMemorySpanExporter::default();
        let metrics = InMemoryMetricExporter::default();
        Self {
            tracer_provider: SdkTracerProvider::builder().with_simple_exporter(spans.clone()).build(),
            meter_provider: SdkMeterProvider::builder()
                .with_reader(PeriodicReader::builder(metrics.clone()).build())
                .build(),
            spans,
            metrics,
        }
    }

    fn telemetry(&self) -> web::Data<HttpTelemetry> {
        let tracer = BoxedTracer::new(Box::new(self.tracer_provider.tracer("test")));
        web::Data::new(HttpTelemetry::new(tracer, &self.meter_provider.meter("test")))
    }

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

/// Sends each request to a new instance of the service, as the service's state is all in its telemetry.
async fn send(sent: &Sent, cors_origins: &[&str], request: TestRequest) -> (StatusCode, HeaderMap, Value) {
    let origins: Vec<String> = cors_origins.iter().map(|origin| (*origin).to_owned()).collect();
    let service = init_service(app(&origins, sent.telemetry())).await;
    let response = call_service(&service, request.to_request()).await;
    let (status, headers) = (response.status(), response.headers().clone());
    let body = read_body(response).await;
    (status, headers, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

async fn get(sent: &Sent, uri: &str) -> (StatusCode, HeaderMap, Value) {
    send(sent, &[], TestRequest::get().uri(uri)).await
}

#[actix_web::test]
async fn answers_the_platforms_health_checks_without_logging_tracing_or_measuring_them() {
    let sent = Sent::new();
    let (logs, _guard) = Captured::start();
    for path in ["/health/live", "/health/ready"] {
        let (status, _, body) = get(&sent, path).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, serde_json::json!({ "status": "ok" }));
    }
    assert!(logs.lines().is_empty());
    assert!(sent.spans().is_empty());
    assert!(!sent.metrics().contains("http.server.request.duration"));
}

#[actix_web::test]
async fn answers_a_ping_and_logs_it() {
    let sent = Sent::new();
    let (logs, _guard) = Captured::start();
    let (status, _, body) = get(&sent, "/api/ping").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
    assert!(humantime::parse_rfc3339(body["time"].as_str().unwrap()).is_ok());
    let lines = logs.lines();
    assert_eq!(lines[0]["msg"], "Ping received");
    assert_eq!(lines[1]["msg"], "request completed");
    assert_eq!(lines[1]["path"], "/api/ping");
    assert_eq!(lines[1]["status"], 200);
}

#[actix_web::test]
async fn greets_by_name_or_the_world() {
    let sent = Sent::new();
    let (logs, _guard) = Captured::start();
    assert_eq!(get(&sent, "/api/hello?name=Ada").await.2["message"], "Hello, Ada!");
    assert_eq!(
        get(&sent, "/api/hello?name=Jos%C3%A9").await.2["message"],
        "Hello, José!"
    );
    assert_eq!(get(&sent, "/api/hello").await.2["message"], "Hello, world!");
    assert_eq!(logs.lines()[0]["greeted"], "Ada");
}

#[actix_web::test]
async fn refuses_a_name_that_is_empty_too_long_or_given_twice() {
    let sent = Sent::new();
    let long = format!("/api/hello?name={}", "x".repeat(101));
    for uri in ["/api/hello?name=", long.as_str(), "/api/hello?name=Ada&name=Alan"] {
        let (status, _, body) = get(&sent, uri).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
        assert_eq!(body["error"], "name must be between 1 and 100 characters.");
    }
    // 100 characters, of two bytes each.
    let longest = format!("/api/hello?name={}", "%C3%A9".repeat(100));
    assert_eq!(get(&sent, &longest).await.0, StatusCode::OK);
}

#[actix_web::test]
async fn answers_404_for_a_route_it_does_not_have() {
    let sent = Sent::new();
    let (status, _, body) = get(&sent, "/api/nothing").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "Not found.");
}

#[actix_web::test]
async fn continues_the_trace_a_caller_started() {
    let sent = Sent::new();
    let (logs, _guard) = Captured::start();
    let traceparent = format!("00-{TRACE_ID}-{CALLER_SPAN_ID}-01");
    send(
        &sent,
        &[],
        TestRequest::get()
            .uri("/api/ping")
            .insert_header(("traceparent", traceparent)),
    )
    .await;
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

#[actix_web::test]
async fn measures_each_request_with_its_route_and_status() {
    let sent = Sent::new();
    get(&sent, "/api/hello?name=").await;
    let metrics = sent.metrics();
    assert!(metrics.contains("http.server.request.duration"), "{metrics}");
    assert!(
        metrics.contains("http.response.status_code") && metrics.contains("400"),
        "{metrics}"
    );
    assert!(metrics.contains("/api/hello"), "{metrics}");
}

#[actix_web::test]
async fn lets_the_web_pages_it_lists_call_it_and_send_their_trace() {
    let sent = Sent::new();
    let shop = ["https://shop.example.com"];
    let preflight = TestRequest::default()
        .method(actix_web::http::Method::OPTIONS)
        .uri("/api/ping")
        .insert_header(("origin", "https://shop.example.com"))
        .insert_header(("access-control-request-method", "GET"))
        .insert_header(("access-control-request-headers", "traceparent"));
    let (status, headers, _) = send(&sent, &shop, preflight).await;
    assert!(status.is_success());
    assert_eq!(
        headers.get("access-control-allow-origin").unwrap(),
        "https://shop.example.com"
    );
    assert!(headers
        .get("access-control-allow-headers")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("traceparent"));
    let request = TestRequest::get()
        .uri("/api/ping")
        .insert_header(("origin", "https://shop.example.com"));
    let (_, headers, _) = send(&sent, &shop, request).await;
    assert_eq!(
        headers.get("access-control-allow-origin").unwrap(),
        "https://shop.example.com"
    );
}

#[actix_web::test]
async fn lets_no_other_web_page_call_it() {
    let sent = Sent::new();
    let request = || {
        TestRequest::get()
            .uri("/api/ping")
            .insert_header(("origin", "https://evil.example.com"))
    };
    let (status, headers, _) = send(&sent, &["https://shop.example.com"], request()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers.get("access-control-allow-origin").is_none());
    let (_, headers, _) = send(&sent, &[], request()).await;
    assert!(headers.get("access-control-allow-origin").is_none());
}
