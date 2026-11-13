//! Logs as one line of JSON each, on standard output, where the platform reads them.
//!
//! Log with `tracing`'s macros, such as `tracing::info!(order = %id, "Order placed")`. Each
//! line says which trace it was written in, in `trace_id` and `span_id`, so the platform shows
//! lines beside their trace.

use std::cell::RefCell;
use std::fmt::Debug;
use std::io::Write;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use opentelemetry::trace::TraceContextExt;
use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use tracing_subscriber::Registry;

/// Writes each event as one line of JSON, with its trace, and the fields it was given, on
/// standard output, or to what the thread it's written on captures, in tests.
pub struct JsonLogs;

impl<S: Subscriber> Layer<S> for JsonLogs {
    fn on_event(&self, event: &Event<'_>, _context: Context<'_, S>) {
        let mut line = Map::new();
        line.insert("time".to_owned(), Value::from(timestamp(SystemTime::now())));
        line.insert(
            "level".to_owned(),
            Value::from(event.metadata().level().as_str().to_ascii_lowercase()),
        );
        let mut fields = Fields::default();
        event.record(&mut fields);
        line.insert("msg".to_owned(), Value::from(fields.message));
        line.insert("logger".to_owned(), Value::from(event.metadata().target()));
        line.extend(trace_fields());
        line.extend(fields.others);
        let line = Value::Object(line).to_string();
        let captured = CAPTURED.with(|captured| captured.borrow().clone());
        match captured {
            Some(captured) => captured.0.lock().unwrap_or_else(PoisonError::into_inner).push(line),
            None => {
                // A log line that can't be written has nowhere else to go.
                let _ = writeln!(std::io::stdout().lock(), "{line}");
            }
        }
    }
}

/// The trace and span a line is written in, with OpenTelemetry's names for them, or nothing.
pub fn trace_fields() -> Map<String, Value> {
    let context = opentelemetry::Context::current();
    let span = context.span();
    let span = span.span_context();
    if !span.is_valid() {
        return Map::new();
    }
    Map::from_iter([
        ("trace_id".to_owned(), Value::from(span.trace_id().to_string())),
        ("span_id".to_owned(), Value::from(span.span_id().to_string())),
        (
            "trace_flags".to_owned(),
            Value::from(format!("{:02x}", span.trace_flags().to_u8())),
        ),
    ])
}

/// Such as 2026-11-10T12:00:00.000Z.
pub fn timestamp(time: SystemTime) -> String {
    humantime::format_rfc3339_millis(time).to_string()
}

#[derive(Default)]
struct Fields {
    message: String,
    others: Map<String, Value>,
}

impl Fields {
    fn add(&mut self, field: &Field, value: Value) {
        match (field.name(), value) {
            ("message", Value::String(message)) => self.message = message,
            (name, value) => {
                self.others.insert(name.to_owned(), value);
            }
        }
    }
}

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.add(field, Value::from(value));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.add(field, Value::from(value));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.add(field, Value::from(value));
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.add(field, Value::from(value));
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.add(field, Value::from(value));
    }
    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.add(field, Value::from(value.to_string()));
    }
    fn record_debug(&mut self, field: &Field, value: &dyn Debug) {
        self.add(field, Value::from(format!("{value:?}")));
    }
}

/// Sends every log line at info level or above to standard output, as JSON.
pub fn init() {
    let logs = Registry::default().with(LevelFilter::INFO).with(JsonLogs);
    // Only fails if logs were already set up, and then they go where they were set up to.
    let _ = tracing::subscriber::set_global_default(logs);
}

thread_local! {
    static CAPTURED: RefCell<Option<Captured>> = const { RefCell::new(None) };
}

/// The log lines written on a thread, for tests.
#[derive(Clone, Default)]
pub struct Captured(Arc<Mutex<Vec<String>>>);

impl Captured {
    /// Captures the lines written on this thread, such as by a test's requests, until the
    /// guard is dropped. Tests run on threads of their own, so each gets only its own lines.
    pub fn start() -> (Self, CaptureGuard) {
        init();
        let captured = Self::default();
        CAPTURED.with(|current| *current.borrow_mut() = Some(captured.clone()));
        (captured, CaptureGuard(()))
    }

    /// Each line written, as JSON.
    pub fn lines(&self) -> Vec<Value> {
        let lines = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        lines
            .iter()
            .map(|line| serde_json::from_str(line).unwrap_or(Value::Null))
            .collect()
    }
}

/// Lines go to standard output again once it's dropped.
pub struct CaptureGuard(());

impl Drop for CaptureGuard {
    fn drop(&mut self) {
        CAPTURED.with(|current| current.borrow_mut().take());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry::trace::{SpanContext, SpanId, TraceFlags, TraceId, TraceState};
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn writes_one_line_of_json_with_the_message_level_and_fields() {
        let (logs, _guard) = Captured::start();
        tracing::info!(order = 42, customer = %"Ada", "Order placed");
        let line = &logs.lines()[0];
        assert_eq!(line["msg"], "Order placed");
        assert_eq!(line["level"], "info");
        assert_eq!(line["order"], 42);
        assert_eq!(line["customer"], "Ada");
        assert!(line["time"].as_str().unwrap().ends_with('Z'));
        assert!(line.get("trace_id").is_none());
    }

    #[test]
    fn leaves_out_debug_lines() {
        let (logs, _guard) = Captured::start();
        tracing::debug!("Details");
        assert!(logs.lines().is_empty());
    }

    #[test]
    fn says_which_trace_and_span_a_line_was_written_in() {
        let span = SpanContext::new(
            TraceId::from_hex("4bf92f3577b34da6a3ce929d0e0e4736").unwrap(),
            SpanId::from_hex("00f067aa0ba902b7").unwrap(),
            TraceFlags::SAMPLED,
            true,
            TraceState::default(),
        );
        let (logs, _guard) = Captured::start();
        {
            let _attached = opentelemetry::Context::current()
                .with_remote_span_context(span)
                .attach();
            tracing::info!("Ping received");
        }
        let line = &logs.lines()[0];
        assert_eq!(line["trace_id"], "4bf92f3577b34da6a3ce929d0e0e4736");
        assert_eq!(line["span_id"], "00f067aa0ba902b7");
        assert_eq!(line["trace_flags"], "01");
    }

    #[test]
    fn writes_times_in_utc_to_the_millisecond() {
        assert_eq!(
            timestamp(UNIX_EPOCH + Duration::from_millis(1_794_312_000_123)),
            "2026-11-10T12:00:00.123Z"
        );
    }
}
