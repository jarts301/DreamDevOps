"""Runs the page with `uv run app`, on PORT, or 8000 when it isn't set."""

import os
import sys
from pathlib import Path

from streamlit.web import cli

DEFAULT_PORT = 8000


def run() -> None:
    port = os.environ.get("PORT") or str(DEFAULT_PORT)
    page = Path(__file__).with_name("page.py")
    sys.argv = [
        "streamlit",
        "run",
        str(page),
        "--server.port",
        port,
        "--server.address",
        "0.0.0.0",
        # Set here rather than only in .streamlit/config.toml, which Streamlit reads from the
        # working directory. Without them, a first run elsewhere waits for input forever.
        "--server.headless",
        "true",
        "--browser.gatherUsageStats",
        "false",
        # People using the app see the app, not Streamlit's developer menu.
        "--client.toolbarMode",
        "viewer",
    ]
    sys.exit(cli.main())
