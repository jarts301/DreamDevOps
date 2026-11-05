from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool

from app.config import Settings
from app.main import create_app


def test_checks_the_database_when_there_is_one() -> None:
    # NullPool closes each connection after use, so none is left open between threads.
    database = create_engine("sqlite://", poolclass=NullPool)

    with TestClient(create_app(Settings(), database)) as client:
        response = client.get("/health")

    assert response.json() == {"status": "ok", "database": "up"}


def test_answers_503_when_the_database_is_down() -> None:
    # Nothing listens on port 1, so connecting fails at once.
    database = create_engine(
        "postgresql+psycopg://user:password@127.0.0.1:1/none", poolclass=NullPool
    )

    with TestClient(create_app(Settings(), database)) as client:
        response = client.get("/health")

    assert response.status_code == 503
    assert response.json() == {"status": "unavailable", "database": "down"}
