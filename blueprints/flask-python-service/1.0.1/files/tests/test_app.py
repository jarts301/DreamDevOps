from service.app import create_app
from tests.conftest import LogLines


def test_reports_that_it_is_alive_and_ready_without_logging_each_check(log_lines: LogLines) -> None:
    client = create_app().test_client()
    for path in ["/health/live", "/health/ready"]:
        response = client.get(path)
        assert response.status_code == 200
        assert response.get_json() == {"status": "ok"}

    assert log_lines() == []


def test_answers_a_ping_and_logs_it_with_the_request(log_lines: LogLines) -> None:
    response = create_app().test_client().get("/api/ping")

    assert response.status_code == 200
    assert response.get_json()["status"] == "ok"
    assert response.get_json()["time"].startswith("20")
    assert [line["msg"] for line in log_lines()] == ["Ping received", "request completed"]
    assert log_lines()[1] | {"duration_ms": 0} == log_lines()[1] | {
        "method": "GET",
        "path": "/api/ping",
        "status": 200,
        "duration_ms": 0,
    }


def test_greets_by_name_and_logs_whom(log_lines: LogLines) -> None:
    client = create_app().test_client()

    assert client.get("/api/hello", query_string={"name": "Ada"}).get_json() == {"message": "Hello, Ada!"}
    assert client.get("/api/hello").get_json() == {"message": "Hello, world!"}
    assert [line.get("greeted") for line in log_lines() if line["msg"] == "Greeting sent"] == ["Ada", "world"]


def test_answers_unknown_paths_with_404_in_json() -> None:
    response = create_app().test_client().get("/nowhere")

    assert response.status_code == 404
    assert "error" in response.get_json()


def test_refuses_unexpected_input_with_400() -> None:
    client = create_app().test_client()
    for query in [{"name": ""}, {"name": "a" * 101}, [("name", "a"), ("name", "b")]]:
        response = client.get("/api/hello", query_string=query)
        assert response.status_code == 400, query
        assert response.get_json()["error"] == "name must be between 1 and 100 characters."


def test_never_logs_request_headers_which_can_hold_credentials(log_lines: LogLines) -> None:
    create_app().test_client().get(
        "/api/ping", headers={"authorization": "Bearer secret-token", "cookie": "s=secret-cookie"}
    )

    assert "secret" not in str(log_lines())


def test_lets_no_other_web_page_call_it_from_a_browser_unless_told_to() -> None:
    response = create_app().test_client().get("/api/ping", headers={"origin": "https://shop.example.com"})

    assert "access-control-allow-origin" not in response.headers


def test_lets_the_web_pages_it_was_given_call_it_with_the_trace_the_page_started() -> None:
    client = create_app(["https://shop.example.com"]).test_client()

    preflight = client.options(
        "/api/ping",
        headers={
            "origin": "https://shop.example.com",
            "access-control-request-method": "GET",
            "access-control-request-headers": "traceparent",
        },
    )
    assert preflight.status_code == 204
    assert preflight.headers["access-control-allow-origin"] == "https://shop.example.com"
    assert "traceparent" in preflight.headers["access-control-allow-headers"]
    response = client.get("/api/ping", headers={"origin": "https://shop.example.com"})
    assert response.headers["access-control-allow-origin"] == "https://shop.example.com"


def test_refuses_web_pages_at_any_other_origin() -> None:
    client = create_app(["https://shop.example.com"]).test_client()

    preflight = client.options(
        "/api/ping", headers={"origin": "https://evil.example.com", "access-control-request-method": "GET"}
    )
    assert preflight.status_code == 403
    assert "access-control-allow-origin" not in preflight.headers
