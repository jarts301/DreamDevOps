"""The app's settings, read from /config.json when it starts.

The container writes that file from environment variables, so one image serves every
environment. In development it's public/config.json.
"""

import json
from dataclasses import dataclass
from typing import cast


@dataclass(frozen=True)
class Settings:
    """The app's settings."""

    api_url: str = "/api"
    """Where the app calls its API, such as /api or https://api.example.com."""


def settings_from(text: str) -> Settings:
    """The settings in the text of /config.json. Anything missing keeps its default."""
    value: object = json.loads(text)
    if not isinstance(value, dict):
        return Settings()
    api_url = cast("dict[str, object]", value).get("apiUrl")
    return Settings(api_url=api_url) if isinstance(api_url, str) and api_url else Settings()
