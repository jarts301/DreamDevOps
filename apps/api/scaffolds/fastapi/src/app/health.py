"""DreamDevOps calls /health to know the API is running."""

from typing import Literal

from fastapi import APIRouter, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import Engine, text


class Health(BaseModel):
    status: Literal["ok", "unavailable"]
    database: Literal["up", "down", "not configured"]


router = APIRouter(tags=["health"])


@router.get("/health")
def health(request: Request, response: Response) -> Health:
    engine: Engine | None = request.app.state.database
    if engine is None:
        return Health(status="ok", database="not configured")
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except Exception:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return Health(status="unavailable", database="down")
    return Health(status="ok", database="up")
