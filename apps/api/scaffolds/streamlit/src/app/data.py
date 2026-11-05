"""Example data for the page. Replace it with your own."""


def growth(weeks: int, rate: float) -> list[float]:
    """How 100 grows, week by week, at a weekly rate given as a percentage."""
    if weeks < 1:
        raise ValueError("There must be at least one week.")
    values = [100.0]
    for _ in range(weeks - 1):
        values.append(round(values[-1] * (1 + rate / 100), 2))
    return values
