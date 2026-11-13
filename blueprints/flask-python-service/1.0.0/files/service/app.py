"""The service's routes, on Flask."""

import logging
import time
from collections.abc import Sequence
from datetime import UTC, datetime

from flask import Flask, Response, g, jsonify, request
from werkzeug.exceptions import HTTPException

from service.logs import request_completed

logger = logging.getLogger("service")

CORS_HEADERS = "content-type, authorization, traceparent, tracestate"
"""Headers browsers may send across origins, including the trace a page started."""


def create_app(cors_origins: Sequence[str] = ()) -> Flask:
    """Builds the service without starting it, so tests can call it directly."""
    app = Flask(__name__)
    origins = set(cors_origins)

    @app.before_request
    def start() -> Response | None:
        g.started = time.perf_counter()
        # Browsers ask first, before a request with a header such as traceparent.
        if origins and request.method == "OPTIONS":
            if request.headers.get("origin") not in origins:
                return Response(status=403)
            response = Response(status=204)
            response.headers["access-control-allow-methods"] = "GET, POST, PUT, PATCH, DELETE"
            response.headers["access-control-allow-headers"] = CORS_HEADERS
            response.headers["access-control-max-age"] = "600"
            return response
        return None

    @app.after_request
    def finish(response: Response) -> Response:
        # Lets web pages at these origins call the service from browsers, and send the trace
        # they started, so a request from a page and its work here are one trace.
        if origins:
            origin = request.headers.get("origin")
            if origin in origins:
                response.headers["access-control-allow-origin"] = origin
            response.headers["vary"] = "Origin"
        started = g.get("started", time.perf_counter())
        request_completed(logger, request.method, request.path, response.status_code, time.perf_counter() - started)
        return response

    @app.errorhandler(HTTPException)
    def http_error(error: HTTPException) -> tuple[Response, int]:
        return jsonify(error=error.description), error.code or 500

    # The platform checks these every few seconds to decide whether to restart the service or
    # send it traffic. They aren't logged or measured, so those show real traffic.
    @app.get("/health/live")
    def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/health/ready")
    def ready() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/ping")
    def ping() -> dict[str, str]:
        """Answers without doing anything, to check the service can be reached, and logs that it was."""
        logger.info("Ping received")
        return {"status": "ok", "time": datetime.now(UTC).isoformat()}

    @app.get("/api/hello")
    def hello() -> tuple[dict[str, str], int]:
        names = request.args.getlist("name") or ["world"]
        if len(names) != 1 or not 1 <= len(names[0]) <= 100:
            return {"error": "name must be between 1 and 100 characters."}, 400
        logger.info("Greeting sent", extra={"greeted": names[0]})
        return {"message": f"Hello, {names[0]}!"}, 200

    return app
