"""Settings, read once from the environment at startup."""

import os
from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import urlsplit

DEFAULT_PORT = 8000


class InvalidSettingError(ValueError):
    """A setting isn't valid, so the API refuses to start."""


@dataclass(frozen=True)
class Settings:
    port: int = DEFAULT_PORT
    # Without one, the API runs, and only what needs the database answers 503.
    database_url: str | None = None

    @property
    def sqlalchemy_url(self) -> str | None:
        """The database URL with SQLAlchemy's driver name, so postgres:// addresses work too."""
        if self.database_url is None:
            return None
        scheme, _, rest = self.database_url.partition("://")
        if scheme in {"postgres", "postgresql"}:
            return f"postgresql+psycopg://{rest}"
        return self.database_url


def load_settings(env: Mapping[str, str] = os.environ) -> Settings:
    raw_port = env.get("PORT") or str(DEFAULT_PORT)
    if not raw_port.isdigit() or not 1 <= int(raw_port) <= 65535:
        raise InvalidSettingError("PORT must be a whole number from 1 to 65535.")

    database_url = env.get("DATABASE_URL") or None
    if database_url is not None and not urlsplit(database_url).scheme:
        raise InvalidSettingError(
            "DATABASE_URL must be a full URL, such as postgresql://user:password@host:5432/database."
        )
    return Settings(port=int(raw_port), database_url=database_url)
