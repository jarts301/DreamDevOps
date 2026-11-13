"""What every test can use."""

import io
import json
import logging
from collections.abc import Callable, Iterator
from typing import Any

import pytest

from service.logs import configure_logging

LogLines = Callable[[], list[dict[str, Any]]]


@pytest.fixture
def log_lines() -> Iterator[LogLines]:
    """What the service logs while a test runs, one JSON object per line."""
    stream = io.StringIO()
    configure_logging(stream)
    # The test client's own lines, about the requests it makes, aren't the service's.
    for client in ["httpx", "httpx2"]:
        logging.getLogger(client).setLevel(logging.WARNING)
    yield lambda: [json.loads(line) for line in stream.getvalue().splitlines()]
    logging.getLogger().handlers.clear()
