import pytest

from app.data import growth


def test_starts_at_100_and_grows_each_week() -> None:
    assert growth(3, 10) == [100.0, 110.0, 121.0]


def test_stays_flat_without_growth() -> None:
    assert growth(4, 0) == [100.0] * 4


def test_needs_at_least_one_week() -> None:
    with pytest.raises(ValueError, match="week"):
        growth(0, 5)
