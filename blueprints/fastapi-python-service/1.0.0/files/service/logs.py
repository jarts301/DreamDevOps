"""Logs as one line of JSON each, on standard output, where the platform reads them.

Each line says which trace it was written in, in trace_id and span_id, so the platform shows
lines beside their trace.
"""

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any, TextIO

from opentelemetry import trace

# What every log record has, so anything else on one came from extra={...}, and is logged too.
_STANDARD = set(logging.LogRecord("", 0, "", 0, "", None, None).__dict__) | {"message", "asctime", "taskName"}


def trace_fields() -> dict[str, str]:
    """The trace and span a line is written in, with OpenTelemetry's names for them, or nothing."""
    context = trace.get_current_span().get_span_context()
    if not context.is_valid:
        return {}
    return {
        "trace_id": format(context.trace_id, "032x"),
        "span_id": format(context.span_id, "016x"),
        "trace_flags": format(context.trace_flags, "02x"),
    }


class JsonFormatter(logging.Formatter):
    """Writes a record as one line of JSON, with its trace, and anything it was given as extra."""

    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "msg": record.getMessage(),
            "logger": record.name,
            **trace_fields(),
        }
        line.update({key: value for key, value in record.__dict__.items() if key not in _STANDARD})
        if record.exc_info:
            line["error"] = self.formatException(record.exc_info)
        return json.dumps(line, default=str)


def configure_logging(stream: TextIO = sys.stdout, level: int = logging.INFO) -> None:
    """Sends every log line, the service's and its libraries', to the stream as JSON."""
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)


def request_completed(logger: logging.Logger, method: str, path: str, status: int, duration_s: float) -> None:
    """Logs a request the service answered, within its trace. Health checks aren't logged."""
    if is_health_check(path):
        return
    logger.info(
        "request completed",
        extra={"method": method, "path": path, "status": status, "duration_ms": round(duration_s * 1000, 3)},
    )


def is_health_check(path: str) -> bool:
    """The platform checks health every few seconds. That isn't traffic, so it isn't logged or measured."""
    return path.startswith("/health/")
