from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.notes import Note, get_notes


class FakeNotes:
    def __init__(self) -> None:
        self.notes: list[Note] = []

    def list(self) -> list[Note]:
        return list(reversed(self.notes))

    def create(self, text: str) -> Note:
        note = Note(id=len(self.notes) + 1, text=text, created_at=datetime.now(UTC))
        self.notes.append(note)
        return note


@pytest.fixture
def notes_client() -> Iterator[TestClient]:
    app = create_app(Settings())
    fake = FakeNotes()
    app.dependency_overrides[get_notes] = lambda: fake
    with TestClient(app) as test_client:
        yield test_client


def test_creates_and_lists_notes(notes_client: TestClient) -> None:
    created = notes_client.post("/notes", json={"text": "Remember the milk"})

    assert created.status_code == 201
    assert created.json()["text"] == "Remember the milk"
    assert [note["text"] for note in notes_client.get("/notes").json()] == ["Remember the milk"]
