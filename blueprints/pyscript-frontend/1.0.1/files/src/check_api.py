"""Check the API: pings it with a trace of its own, so its logs and trace can be found."""

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from trace_context import new_traceparent, trace_id_of

Fetcher = Callable[[str, Mapping[str, str]], Awaitable[int]]
"""Calls a URL with these headers, and gives the HTTP status. Raises when nothing answers."""


@dataclass(frozen=True)
class Check:
    """How a check of the API went."""

    answered: bool
    message: str
    trace_id: str
    """The trace the check started, to look for in the API's logs and traces."""


async def check_api(api_url: str, fetcher: Fetcher) -> Check:
    """Calls the API's ping, with a trace of its own."""
    traceparent = new_traceparent()
    trace_id = trace_id_of(traceparent)
    try:
        status = await fetcher(f"{api_url.rstrip('/')}/ping", {"traceparent": traceparent})
    except Exception:
        return Check(answered=False, message="The API didn't answer.", trace_id=trace_id)
    if 200 <= status < 300:
        return Check(answered=True, message="The API answered.", trace_id=trace_id)
    return Check(answered=False, message=f"The API didn't answer (HTTP {status}).", trace_id=trace_id)
