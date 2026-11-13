import pytest

from service.config import Config, load_config


def test_uses_port_8080_on_every_network_interface_by_default_and_lets_no_web_page_call_it() -> None:
    assert load_config({}) == Config(host="0.0.0.0", port=8080, cors_origins=())


def test_refuses_a_port_that_is_not_valid() -> None:
    for port in ["eighty", "0", "70000", "-1"]:
        with pytest.raises(ValueError, match="PORT must be a whole number"):
            load_config({"PORT": port})


def test_lets_the_web_pages_it_lists_call_it() -> None:
    config = load_config({"CORS_ORIGINS": " https://shop.example.com, http://localhost:49154 ,"})

    assert config.cors_origins == ("https://shop.example.com", "http://localhost:49154")


def test_refuses_something_that_is_not_an_origin() -> None:
    for value in ["*", "shop.example.com", "https://shop.example.com/path"]:
        with pytest.raises(ValueError, match="CORS_ORIGINS must list origins"):
            load_config({"CORS_ORIGINS": value})
