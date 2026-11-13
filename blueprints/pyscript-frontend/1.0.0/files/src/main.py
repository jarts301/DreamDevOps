"""The app's page, in Python, running in the browser with PyScript.

It reads the settings, shows where the app calls its API, and lets people check the API.
Everything people see comes from text, never markup, so nothing from the API or the
settings can add HTML to the page.
"""

import asyncio
from collections.abc import Mapping

from pyscript import document, fetch, when

from app_info import APP_NAME
from check_api import Check, check_api
from runtime_config import Settings, settings_from

settings = Settings()
"""The settings, once read. Until then, the defaults."""


async def load_settings() -> Settings:
    """Reads /config.json, or keeps the defaults when it can't be read."""
    response = await fetch("/config.json", cache="no-store")
    if not response.ok:
        print(f"The settings couldn't be read (HTTP {response.status}).")
        return Settings()
    return settings_from(await response.text())


async def status_of(url: str, headers: Mapping[str, str]) -> int:
    """Calls a URL with the browser's fetch, and gives the HTTP status."""
    response = await fetch(url, headers=dict(headers))
    return int(response.status)


def show(check: Check) -> None:
    """Shows how the check went, with the trace ID it started."""
    message = document.createElement("p")
    message.setAttribute("role", "status")
    message.append(f"{check.message} Trace ID: ")
    code = document.createElement("code")
    code.textContent = check.trace_id
    message.append(code)
    document.querySelector("#check-result").replaceChildren(message)


async def start() -> None:
    """Reads the settings, then shows them, and lets people check the API."""
    global settings
    settings = await load_settings()
    document.querySelector("h1").textContent = APP_NAME
    document.querySelector("#api-url").textContent = settings.api_url
    document.querySelector("#check-api").disabled = False


@when("click", "#check-api")
async def on_check() -> None:
    button = document.querySelector("#check-api")
    button.disabled = True
    try:
        show(await check_api(settings.api_url, status_of))
    finally:
        button.disabled = False


asyncio.ensure_future(start())
