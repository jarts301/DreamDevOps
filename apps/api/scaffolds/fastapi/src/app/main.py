"""Creates the API, and runs it with `uv run app`."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from sqlalchemy import Engine

from app import health, notes
from app.about import ABOUT
from app.config import Settings, load_settings
from app.database import create_database


def create_app(settings: Settings | None = None, database: Engine | None = None) -> FastAPI:
    """Tests pass their own settings and database. The server reads them from the environment."""
    settings = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.database = database if database is not None else create_database(settings)
        yield
        if app.state.database is not None:
            app.state.database.dispose()

    app = FastAPI(title=ABOUT["name"], description=ABOUT["description"], lifespan=lifespan)
    app.include_router(health.router)
    app.include_router(notes.router)

    @app.get("/", tags=["about"])
    def about() -> dict[str, str]:
        return ABOUT

    return app


def run() -> None:
    settings = load_settings()
    uvicorn.run(create_app(settings), host="0.0.0.0", port=settings.port)
