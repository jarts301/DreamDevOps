"""The API's name and description, kept in about.json so any text is safe in them."""

import json
from importlib.resources import files

ABOUT: dict[str, str] = json.loads(files("app").joinpath("about.json").read_text(encoding="utf-8"))
