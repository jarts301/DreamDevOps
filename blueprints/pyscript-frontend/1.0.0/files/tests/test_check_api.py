import unittest
from collections.abc import Mapping

from check_api import check_api
from tests.helpers import run
from trace_context import trace_id_of


class CheckApiTest(unittest.TestCase):
    def test_pings_the_api_with_a_new_trace_and_gives_its_id(self) -> None:
        calls: list[tuple[str, dict[str, str]]] = []

        async def answering(url: str, headers: Mapping[str, str]) -> int:
            calls.append((url, dict(headers)))
            return 200

        check = run(check_api("https://api.example.com/", answering))

        self.assertEqual(calls[0][0], "https://api.example.com/ping")
        self.assertTrue(check.answered)
        self.assertEqual(check.message, "The API answered.")
        self.assertEqual(check.trace_id, trace_id_of(calls[0][1]["traceparent"]))

    def test_says_when_the_api_answers_with_an_error(self) -> None:
        async def failing(_url: str, _headers: Mapping[str, str]) -> int:
            return 503

        check = run(check_api("/api", failing))

        self.assertFalse(check.answered)
        self.assertEqual(check.message, "The API didn't answer (HTTP 503).")

    def test_says_when_nothing_answers(self) -> None:
        async def unreachable(_url: str, _headers: Mapping[str, str]) -> int:
            raise OSError("Failed to fetch")

        self.assertEqual(run(check_api("/api", unreachable)).message, "The API didn't answer.")


if __name__ == "__main__":
    unittest.main()
