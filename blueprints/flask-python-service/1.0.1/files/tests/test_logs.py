import logging

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags, use_span

from service.logs import is_health_check, request_completed
from tests.conftest import LogLines


def test_lines_are_json_and_say_which_trace_and_span_they_were_written_in(log_lines: LogLines) -> None:
    span = NonRecordingSpan(
        SpanContext(
            trace_id=0x4BF92F3577B34DA6A3CE929D0E0E4736,
            span_id=0x00F067AA0BA902B7,
            is_remote=False,
            trace_flags=TraceFlags(TraceFlags.SAMPLED),
        )
    )
    with use_span(span):
        logging.getLogger("service").info("Order placed", extra={"order": 42})

    assert log_lines() == [
        {
            "time": log_lines()[0]["time"],
            "level": "info",
            "msg": "Order placed",
            "logger": "service",
            "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
            "span_id": "00f067aa0ba902b7",
            "trace_flags": "01",
            "order": 42,
        }
    ]


def test_lines_say_nothing_about_traces_when_there_is_none(log_lines: LogLines) -> None:
    logging.getLogger("service").warning("No trace here")
    with TracerProvider().get_tracer("test").start_as_current_span("request"):
        pass

    assert "trace_id" not in log_lines()[0]
    assert log_lines()[0]["level"] == "warning"


def test_errors_carry_what_went_wrong(log_lines: LogLines) -> None:
    try:
        raise RuntimeError("Payment failed")
    except RuntimeError:
        logging.getLogger("service").exception("Request failed")

    assert "RuntimeError: Payment failed" in log_lines()[0]["error"]


def test_requests_are_logged_but_not_health_checks(log_lines: LogLines) -> None:
    logger = logging.getLogger("service")
    request_completed(logger, "GET", "/api/ping", 200, 0.0123)
    request_completed(logger, "GET", "/health/live", 200, 0.001)

    assert [(line["msg"], line["path"], line["status"], line["duration_ms"]) for line in log_lines()] == [
        ("request completed", "/api/ping", 200, 12.3)
    ]
    assert is_health_check("/health/ready")
    assert not is_health_check("/api/hello")
