"""Runs migrations for Alembic, against the URL that app.migrate or alembic.ini gives it."""

import os

from alembic import context
from sqlalchemy import create_engine

from app.config import load_settings

url = context.config.get_main_option("sqlalchemy.url") or load_settings(os.environ).sqlalchemy_url
if url is None:
    raise SystemExit("Set DATABASE_URL to the database to migrate.")

with create_engine(url).connect() as connection:
    context.configure(connection=connection)
    with context.begin_transaction():
        context.run_migrations()
