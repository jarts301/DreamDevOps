import pytest
from fastapi.testclient import TestClient

from app.about import ABOUT


def test_says_what_it_is(client: TestClient) -> None:
    response = client.get("/")

    assert response.status_code == 200
    assert response.json() == ABOUT


def test_is_healthy_without_a_database(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "not configured"}


def test_explains_that_notes_need_a_database(client: TestClient) -> None:
    response = client.get("/notes")

    assert response.status_code == 503
    assert "DATABASE_URL" in response.json()["detail"]


@pytest.mark.parametrize("body", [{}, {"text": ""}, {"text": 42}, {"text": "ok", "extra": True}])
def test_refuses_a_note_that_is_not_valid(client: TestClient, body: dict[str, object]) -> None:
    assert client.post("/notes", json=body).status_code == 422
