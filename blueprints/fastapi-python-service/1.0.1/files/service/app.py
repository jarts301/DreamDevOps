"""The service's routes, on FastAPI."""

import logging
import time
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime
from typing import Annotated

from fastapi import FastAPI, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from service.logs import request_completed

logger = logging.getLogger("service")

CORS_HEADERS = ["content-type", "authorization", "traceparent", "tracestate"]
"""Headers browsers may send across origins, including the trace a page started."""


def create_app(cors_origins: Sequence[str] = ()) -> FastAPI:
    """Builds the service without starting it, so tests can call it directly."""
    app = FastAPI(title="__APP_SLUG__")

    @app.middleware("http")
    async def log_requests(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        started = time.perf_counter()
        response = await call_next(request)
        request_completed(logger, request.method, request.url.path, response.status_code, time.perf_counter() - started)
        return response

    if cors_origins:
        # Lets web pages at these origins call the service from browsers, and send the trace
        # they started, so a request from a page and its work here are one trace.
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(cors_origins),
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=CORS_HEADERS,
            max_age=600,
        )

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, error: RequestValidationError) -> JSONResponse:
        # 400, as every DreamDevOps service answers a request it can't take, rather than FastAPI's 422.
        return JSONResponse(status_code=400, content={"error": "The request isn't valid.", "detail": error.errors()})

    # The platform checks these every few seconds to decide whether to restart the service or
    # send it traffic. They aren't logged or measured, so those show real traffic.
    @app.get("/health/live")
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/health/ready")
    async def ready() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/ping")
    async def ping() -> dict[str, str]:
        """Answers without doing anything, to check the service can be reached, and logs that it was."""
        logger.info("Ping received")
        return {"status": "ok", "time": datetime.now(UTC).isoformat()}

    @app.get("/api/hello")
    async def hello(name: Annotated[str, Query(min_length=1, max_length=100)] = "world") -> dict[str, str]:
        logger.info("Greeting sent", extra={"greeted": name})
        return {"message": f"Hello, {name}!"}

    return app
