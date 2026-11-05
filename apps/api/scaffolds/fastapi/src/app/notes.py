"""An example resource that uses the database. Replace it with your own."""

from datetime import datetime
from typing import Annotated, Protocol

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Engine, text


class NoteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=500)


class Note(BaseModel):
    id: int
    text: str
    created_at: datetime


class Notes(Protocol):
    def list(self) -> list[Note]: ...

    def create(self, text: str) -> Note: ...


class DatabaseNotes:
    """Notes in the table that migrations/versions/0001_create_notes.py creates."""

    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def list(self) -> list[Note]:
        with self._engine.connect() as connection:
            rows = connection.execute(
                text(
                    "SELECT id, text, created_at FROM notes "
                    "ORDER BY created_at DESC, id DESC LIMIT 100"
                )
            )
            return [Note.model_validate(row._mapping) for row in rows]

    def create(self, note_text: str) -> Note:
        with self._engine.begin() as connection:
            row = connection.execute(
                text("INSERT INTO notes (text) VALUES (:text) RETURNING id, text, created_at"),
                {"text": note_text},
            ).one()
            return Note.model_validate(row._mapping)


class UnavailableNotes:
    """Stands in without a database. It fails only when used, so requests are validated first."""

    def list(self) -> list[Note]:
        raise self._unavailable()

    def create(self, text: str) -> Note:
        raise self._unavailable()

    @staticmethod
    def _unavailable() -> HTTPException:
        return HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Notes need a database. Set DATABASE_URL and run uv run migrate.",
        )


def get_notes(request: Request) -> Notes:
    engine: Engine | None = request.app.state.database
    return UnavailableNotes() if engine is None else DatabaseNotes(engine)


router = APIRouter(prefix="/notes", tags=["notes"])
NotesDependency = Annotated[Notes, Depends(get_notes)]


@router.get("")
def list_notes(notes: NotesDependency) -> list[Note]:
    return notes.list()


@router.post("", status_code=status.HTTP_201_CREATED)
def create_note(note: NoteIn, notes: NotesDependency) -> Note:
    return notes.create(note.text)
