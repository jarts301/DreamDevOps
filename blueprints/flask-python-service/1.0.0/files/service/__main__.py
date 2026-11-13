"""Starts the service: python -m service."""

import os
import signal
import sys
from types import FrameType

from opentelemetry.instrumentation.flask import FlaskInstrumentor
from waitress import serve

from service.app import create_app
from service.config import load_config
from service.logs import configure_logging
from service.telemetry import HEALTH_CHECKS, start_telemetry


def _stop(_signal: int, _frame: FrameType | None) -> None:
    # The platform stops the service with SIGTERM. Leaving through SystemExit lets it send the
    # telemetry still waiting, below, rather than dropping it.
    sys.exit(0)


def main() -> None:
    config = load_config(os.environ)
    configure_logging()
    stop_telemetry = start_telemetry()
    app = create_app(config.cors_origins)
    # Measures and traces every request the service answers, with its route, status and
    # duration, and continues the trace a caller started, from its traceparent header.
    # OpenTelemetry's Flask instrumentation has no type annotations yet.
    FlaskInstrumentor.instrument_app(app, excluded_urls=HEALTH_CHECKS)  # type: ignore[no-untyped-call]
    signal.signal(signal.SIGTERM, _stop)
    try:
        # Waitress serves with threads in one process, so telemetry, started above, keeps sending.
        serve(app, host=config.host, port=config.port, ident=None)
    finally:
        stop_telemetry()


if __name__ == "__main__":
    main()
