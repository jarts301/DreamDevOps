import pytest

from app.config import InvalidSettingError, Settings, load_settings


def test_listens_on_port_8000_without_a_database_by_default() -> None:
    assert load_settings({}) == Settings(port=8000, database_url=None)


def test_reads_the_port_and_database() -> None:
    settings = load_settings({"PORT": "9000", "DATABASE_URL": "postgres://app@db/app"})

    assert settings.port == 9000
    assert settings.sqlalchemy_url == "postgresql+psycopg://app@db/app"


@pytest.mark.parametrize("port", ["abc", "0", "70000", "80.5", "-1"])
def test_refuses_the_port(port: str) -> None:
    with pytest.raises(InvalidSettingError, match="PORT"):
        load_settings({"PORT": port})


def test_refuses_a_database_address_that_is_not_a_url() -> None:
    with pytest.raises(InvalidSettingError, match="DATABASE_URL"):
        load_settings({"DATABASE_URL": "not a url"})
