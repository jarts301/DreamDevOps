"""Reads the service's settings from environment variables, so one image runs in every environment."""

import re
from collections.abc import Mapping
from dataclasses import dataclass

_ORIGIN = re.compile(r"^https?://[A-Za-z0-9.-]+(:\d{1,5})?$")


@dataclass(frozen=True)
class Config:
    """The service's settings."""

    host: str = "0.0.0.0"
    port: int = 8080
    cors_origins: tuple[str, ...] = ()
    """Web pages at these origins may call the service from browsers, such as https://shop.example.com."""


def load_config(env: Mapping[str, str]) -> Config:
    """The settings in these environment variables. Raises ValueError for one that isn't valid."""
    port = env.get("PORT", "8080")
    if not port.isdigit() or not 1 <= int(port) <= 65_535:
        raise ValueError("PORT must be a whole number between 1 and 65535.")
    origins = tuple(origin.strip() for origin in env.get("CORS_ORIGINS", "").split(",") if origin.strip())
    for origin in origins:
        if not _ORIGIN.match(origin):
            raise ValueError(
                f'CORS_ORIGINS must list origins such as https://shop.example.com, and "{origin}" isn\'t one.'
            )
    return Config(host=env.get("HOST", "0.0.0.0"), port=int(port), cors_origins=origins)
