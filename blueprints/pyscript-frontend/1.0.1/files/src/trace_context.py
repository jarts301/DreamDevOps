"""Traces across the app and the API it calls.

Each call to the app's own API starts a W3C trace, with a traceparent header. The API
continues it, and so do the services it calls, so one click is one trace across all of them.
"""

import secrets
from collections.abc import Callable, Mapping

RandomBytes = Callable[[int], bytes]
"""Gives so many random bytes. Tests pass their own."""


def new_traceparent(random_bytes: RandomBytes = secrets.token_bytes) -> str:
    """A traceparent header that starts a new trace, such as
    00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01."""
    return f"00-{random_bytes(16).hex()}-{random_bytes(8).hex()}-01"


def trace_id_of(traceparent: str) -> str:
    """The trace ID in a traceparent header, which is how the trace is found."""
    parts = traceparent.split("-")
    return parts[1] if len(parts) > 1 else ""


def is_api_call(url: str, api_url: str) -> bool:
    """Whether a URL is one of the app's own API, such as /api/orders when the API is at /api."""
    api = api_url.rstrip("/")
    return url == api or url.startswith(f"{api}/")


def with_trace(url: str, headers: Mapping[str, str], api_url: str) -> dict[str, str]:
    """The headers for a call, with a new trace if it goes to the app's own API and has none.

    Calls anywhere else, such as for /config.json, don't get one, so no trace leaks to other sites.
    """
    result = dict(headers)
    if is_api_call(url, api_url) and not any(name.lower() == "traceparent" for name in result):
        result["traceparent"] = new_traceparent()
    return result
