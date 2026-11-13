"""Helpers for the tests."""

from collections.abc import Coroutine
from typing import Any


def run[T](coroutine: Coroutine[Any, Any, T]) -> T:
    """Runs a coroutine that never waits for anything outside the test, such as with a fake fetch."""
    try:
        coroutine.send(None)
    except StopIteration as done:
        return done.value
    coroutine.close()
    raise AssertionError("It waited for something the test doesn't provide.")
