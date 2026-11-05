"""Applies the migrations in migrations/ to DATABASE_URL, with `uv run migrate`."""

from importlib.resources import files

from alembic import command
from alembic.config import Config

from app.config import load_settings


def alembic_config(url: str) -> Config:
    config = Config()
    config.set_main_option("script_location", str(files("app").joinpath("migrations")))
    # Alembic reads options with % interpolation, so a % in a password must be doubled.
    config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    return config


def run() -> None:
    url = load_settings().sqlalchemy_url
    if url is None:
        print("DATABASE_URL isn't set, so there's no database to migrate.")
        return
    command.upgrade(alembic_config(url), "head")
    print("The database is up to date.")
