from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def client() -> Iterator[TestClient]:
    """The API without a database."""
    with TestClient(create_app(Settings())) as test_client:
        yield test_client
