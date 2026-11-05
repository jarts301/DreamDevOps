from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

from app.about import ABOUT

PAGE = Path(__file__).parents[1] / "src" / "app" / "page.py"
# The first run imports the charting libraries, which can take a while on a busy machine.
TIMEOUT_SECONDS = 30


@pytest.fixture
def page() -> AppTest:
    return AppTest.from_file(str(PAGE), default_timeout=TIMEOUT_SECONDS).run()


def test_shows_the_name_of_the_app(page: AppTest) -> None:
    assert not page.exception
    assert page.title[0].value == ABOUT["name"]


def test_shows_where_growth_ends(page: AppTest) -> None:
    page.slider(key="weeks").set_value(3).run()
    page.number_input(key="rate").set_value(10.0).run()

    assert page.metric[0].value == "121.00"


def test_counts_clicks(page: AppTest) -> None:
    assert page.markdown[-1].value == "Clicked 0 times"

    page.button(key="click").click().run()

    assert page.markdown[-1].value == "Clicked 1 time"
