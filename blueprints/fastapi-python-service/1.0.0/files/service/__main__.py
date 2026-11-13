"""Starts the service: python -m service."""

import os

import uvicorn
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

from service.app import create_app
from service.config import load_config
from service.logs import configure_logging
from service.telemetry import HEALTH_CHECKS, start_telemetry


def main() -> None:
    config = load_config(os.environ)
    configure_logging()
    stop_telemetry = start_telemetry()
    app = create_app(config.cors_origins)
    # Measures and traces every request the service answers, with its route, status and
    # duration, and continues the trace a caller started, from its traceparent header.
    FastAPIInstrumentor.instrument_app(app, excluded_urls=HEALTH_CHECKS)
    try:
        # Uvicorn's own lines go through the JSON logs, and each request is logged by the app.
        uvicorn.run(app, host=config.host, port=config.port, log_config=None, access_log=False, server_header=False)
    finally:
        stop_telemetry()


if __name__ == "__main__":
    main()
