"""Types for the parts of PyScript the app uses. PyScript itself runs only in the browser.

See https://docs.pyscript.net for everything it offers. Add what you use here, so Pyright
can check it.
"""

from collections.abc import Callable
from typing import Any

document: Any
"""The page's document, as in JavaScript."""

window: Any
"""The browser's window, as in JavaScript."""

def fetch(url: str, **options: Any) -> Any:
    """The browser's fetch, with its options as keyword arguments, such as headers."""

def when[F: Callable[..., Any]](event_type: str, selector: str | None = None, **options: Any) -> Callable[[F], F]:
    """Calls the decorated function when the event happens on the elements the selector finds."""
