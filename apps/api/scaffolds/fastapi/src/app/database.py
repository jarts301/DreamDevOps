"""The database connection, or None when no database is configured."""

from sqlalchemy import Engine, create_engine

from app.config import Settings


def create_database(settings: Settings) -> Engine | None:
    url = settings.sqlalchemy_url
    return None if url is None else create_engine(url, pool_pre_ping=True)
