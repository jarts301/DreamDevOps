//! Sends metrics and traces over OTLP, only when told where, with the standard `OTEL_*` variables.
//!
//! The platform sets the ones for metrics and traces, so it can show them on its dashboard.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use opentelemetry::global::{self, BoxedTracer};
use opentelemetry::metrics::{Histogram, Meter};
use opentelemetry::propagation::Extractor;
use opentelemetry::trace::{SpanKind, Status, TraceContextExt, Tracer};
use opentelemetry::{Context, KeyValue};
use opentelemetry_otlp::{MetricExporter, SpanExporter};
use opentelemetry_sdk::metrics::{PeriodicReader, SdkMeterProvider};
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;

/// The name traces and metrics come under, unless `OTEL_SERVICE_NAME` says another.
pub const SERVICE_NAME: &str = "__APP_SLUG__";

const DEFAULT_EXPORT_INTERVAL: Duration = Duration::from_millis(15_000);

/// The buckets of response times, in seconds, that OpenTelemetry recommends for HTTP.
const DURATION_BUCKETS: [f64; 14] = [
    0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0,
];

/// What the service sends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelemetrySettings {
    /// Whether to send metrics. The platform asks for them, to show them on its dashboard.
    pub metrics: bool,
    /// Whether to send traces.
    pub traces: bool,
    pub export_interval: Duration,
}

/// Sends only what it's told where to send, so it sends nothing by default.
pub fn telemetry_settings(env: &HashMap<String, String>) -> TelemetrySettings {
    let set = |name: &str| env.get(name).is_some_and(|value| !value.is_empty());
    let interval = env
        .get("OTEL_METRIC_EXPORT_INTERVAL")
        .and_then(|value| value.parse::<u64>().ok());
    TelemetrySettings {
        metrics: set("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT") || set("OTEL_EXPORTER_OTLP_ENDPOINT"),
        traces: set("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") || set("OTEL_EXPORTER_OTLP_ENDPOINT"),
        export_interval: interval
            .filter(|ms| *ms > 0)
            .map_or(DEFAULT_EXPORT_INTERVAL, Duration::from_millis),
    }
}

/// What sends metrics and traces, until it's shut down.
#[derive(Default)]
pub struct Telemetry {
    tracer_provider: Option<SdkTracerProvider>,
    meter_provider: Option<SdkMeterProvider>,
}

impl Telemetry {
    /// Sends anything still waiting, before the process stops.
    pub fn shutdown(self) {
        // Shutting down can only fail to send, and there's nothing left to do about it then.
        if let Some(provider) = self.tracer_provider {
            let _ = provider.shutdown();
        }
        if let Some(provider) = self.meter_provider {
            let _ = provider.shutdown();
        }
    }
}

/// Starts sending what's asked for. Start it before the async runtime, as it sends from
/// threads of its own, with a blocking HTTP client.
pub fn start_telemetry(env: &HashMap<String, String>) -> Result<Telemetry, String> {
    let settings = telemetry_settings(env);
    // A request that arrives with a W3C traceparent header continues the caller's trace.
    global::set_text_map_propagator(TraceContextPropagator::new());
    // The platform adds the environment's ID to OTEL_RESOURCE_ATTRIBUTES, which the resource reads.
    let name = env
        .get("OTEL_SERVICE_NAME")
        .filter(|name| !name.is_empty())
        .map_or(SERVICE_NAME, String::as_str);
    let resource = Resource::builder().with_service_name(name.to_owned()).build();
    let mut telemetry = Telemetry::default();
    if settings.traces {
        // The exporters read where to send from the OTEL_EXPORTER_OTLP_* variables.
        let exporter = SpanExporter::builder()
            .with_http()
            .build()
            .map_err(|error| error.to_string())?;
        let provider = SdkTracerProvider::builder()
            .with_batch_exporter(exporter)
            .with_resource(resource.clone())
            .build();
        global::set_tracer_provider(provider.clone());
        telemetry.tracer_provider = Some(provider);
    }
    if settings.metrics {
        let exporter = MetricExporter::builder()
            .with_http()
            .build()
            .map_err(|error| error.to_string())?;
        let reader = PeriodicReader::builder(exporter)
            .with_interval(settings.export_interval)
            .build();
        let provider = SdkMeterProvider::builder()
            .with_reader(reader)
            .with_resource(resource)
            .build();
        global::set_meter_provider(provider.clone());
        observe_process(&global::meter(SERVICE_NAME));
        telemetry.meter_provider = Some(provider);
    }
    Ok(telemetry)
}

/// Reports the CPU time and memory the service uses, with their standard OpenTelemetry names,
/// so any tool that reads OpenTelemetry metrics, such as the platform, shows them.
pub fn observe_process(meter: &Meter) {
    meter
        .f64_observable_counter("process.cpu.time")
        .with_unit("s")
        .with_description("CPU time the process has used.")
        .with_callback(|observer| {
            let (user, system) = process::cpu_time();
            observer.observe(user, &[KeyValue::new("cpu.mode", "user")]);
            observer.observe(system, &[KeyValue::new("cpu.mode", "system")]);
        })
        .build();
    meter
        .i64_observable_up_down_counter("process.memory.usage")
        .with_unit("By")
        .with_description("Memory the process holds in RAM.")
        .with_callback(|observer| observer.observe(process::resident_memory(), &[]))
        .build();
}

mod process {
    /// CPU time used so far, in seconds, in user and system mode.
    #[cfg(unix)]
    pub fn cpu_time() -> (f64, f64) {
        // SAFETY: getrusage only writes the struct it's given, which is fully initialized.
        let usage = unsafe {
            let mut usage: libc::rusage = std::mem::zeroed();
            libc::getrusage(libc::RUSAGE_SELF, &mut usage);
            usage
        };
        let seconds = |time: libc::timeval| time.tv_sec as f64 + time.tv_usec as f64 / 1e6;
        (seconds(usage.ru_utime), seconds(usage.ru_stime))
    }

    /// Windows has no getrusage, so while developing there, there's nothing to report.
    #[cfg(not(unix))]
    pub fn cpu_time() -> (f64, f64) {
        (0.0, 0.0)
    }

    /// Memory held in RAM, in bytes. The container runs on Linux, which says what's in RAM now.
    /// Elsewhere, such as while developing on a Mac, there's nothing to report.
    pub fn resident_memory() -> i64 {
        let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
        status
            .lines()
            .find_map(|line| line.strip_prefix("VmRSS:"))
            .and_then(|size| size.trim().strip_suffix("kB")?.trim().parse::<i64>().ok())
            .map_or(0, |kilobytes| kilobytes * 1024)
    }
}

/// The platform checks health every few seconds. That isn't traffic, so it isn't logged, traced or measured.
pub fn is_health_check(path: &str) -> bool {
    path.starts_with("/health/")
}

/// Traces and measures each request the service answers, and logs it.
pub struct HttpTelemetry {
    tracer: BoxedTracer,
    duration: Histogram<f64>,
}

impl HttpTelemetry {
    /// Sends with what `start_telemetry` set up, or nothing, if it sent nothing.
    pub fn global() -> Self {
        Self::new(global::tracer(SERVICE_NAME), &global::meter(SERVICE_NAME))
    }

    pub fn new(tracer: BoxedTracer, meter: &Meter) -> Self {
        let duration = meter
            .f64_histogram("http.server.request.duration")
            .with_unit("s")
            .with_description("How long each request took to answer.")
            .with_boundaries(DURATION_BUCKETS.to_vec())
            .build();
        Self { tracer, duration }
    }

    /// Starts a request's span, continuing the trace in its headers, unless it's a health check.
    /// `route` is the route it matched, such as /api/hello, or empty when none did.
    pub fn start(&self, method: &str, route: &str, path: &str, headers: &dyn Extractor) -> Option<ObservedRequest<'_>> {
        if is_health_check(path) {
            return None;
        }
        let caller = global::get_text_map_propagator(|propagator| propagator.extract(headers));
        let mut attributes = vec![
            KeyValue::new("http.request.method", method.to_owned()),
            KeyValue::new("url.path", path.to_owned()),
        ];
        if !route.is_empty() {
            attributes.push(KeyValue::new("http.route", route.to_owned()));
        }
        let span = self
            .tracer
            .span_builder(if route.is_empty() {
                method.to_owned()
            } else {
                format!("{method} {route}")
            })
            .with_kind(SpanKind::Server)
            .with_attributes(attributes)
            .start_with_context(&self.tracer, &caller);
        Some(ObservedRequest {
            telemetry: self,
            context: caller.with_span(span),
            method: method.to_owned(),
            route: route.to_owned(),
            path: path.to_owned(),
            started: Instant::now(),
        })
    }
}

/// A request being answered, within its span.
pub struct ObservedRequest<'a> {
    telemetry: &'a HttpTelemetry,
    context: Context,
    method: String,
    route: String,
    path: String,
    started: Instant,
}

impl ObservedRequest<'_> {
    /// The request's trace, for the code that answers it, so its log lines and spans are in it.
    pub fn context(&self) -> Context {
        self.context.clone()
    }

    /// Ends the request's span, measures how long it took, and logs it.
    pub fn finish(self, status: u16) {
        let seconds = self.started.elapsed().as_secs_f64();
        let _attached = self.context.clone().attach();
        tracing::info!(
            method = %self.method,
            path = %self.path,
            status,
            duration_ms = (seconds * 1e6).round() / 1e3,
            "request completed"
        );
        let mut attributes = vec![
            KeyValue::new("http.request.method", self.method),
            KeyValue::new("http.response.status_code", i64::from(status)),
        ];
        if !self.route.is_empty() {
            attributes.push(KeyValue::new("http.route", self.route));
        }
        self.telemetry.duration.record(seconds, &attributes);
        let span = self.context.span();
        span.set_attribute(KeyValue::new("http.response.status_code", i64::from(status)));
        if status >= 500 {
            span.set_status(Status::error(""));
        }
        span.end();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn sends_nothing_unless_told_where() {
        let settings = telemetry_settings(&env(&[]));
        assert!(!settings.metrics && !settings.traces);
        assert_eq!(settings.export_interval, Duration::from_secs(15));
    }

    #[test]
    fn sends_what_it_is_told_where_to_send() {
        let settings = telemetry_settings(&env(&[
            (
                "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
                "http://collector:4318/v1/metrics",
            ),
            ("OTEL_METRIC_EXPORT_INTERVAL", "1000"),
        ]));
        assert!(settings.metrics && !settings.traces);
        assert_eq!(settings.export_interval, Duration::from_secs(1));
        let settings = telemetry_settings(&env(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")]));
        assert!(settings.metrics && settings.traces);
    }

    #[test]
    fn keeps_the_default_interval_when_the_one_given_is_not_valid() {
        for interval in ["0", "soon", "-5"] {
            let settings = telemetry_settings(&env(&[("OTEL_METRIC_EXPORT_INTERVAL", interval)]));
            assert_eq!(settings.export_interval, DEFAULT_EXPORT_INTERVAL);
        }
    }

    #[test]
    fn measures_the_process() {
        let (user, system) = process::cpu_time();
        assert!(user >= 0.0 && system >= 0.0);
        if cfg!(target_os = "linux") {
            assert!(process::resident_memory() > 0);
        }
    }

    #[test]
    fn knows_health_checks() {
        assert!(is_health_check("/health/live") && is_health_check("/health/ready"));
        assert!(!is_health_check("/api/ping") && !is_health_check("/healthy"));
    }
}
