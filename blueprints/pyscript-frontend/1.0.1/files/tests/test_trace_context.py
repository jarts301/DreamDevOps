import re
import unittest

from trace_context import is_api_call, new_traceparent, trace_id_of, with_trace

TRACEPARENT = re.compile(r"^00-([0-9a-f]{32})-[0-9a-f]{16}-01$")


class TraceContextTest(unittest.TestCase):
    def test_makes_w3c_traceparent_headers_from_random_bytes(self) -> None:
        def counting(length: int) -> bytes:
            return bytes(range(1, length + 1))

        self.assertEqual(new_traceparent(counting), "00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01")
        self.assertRegex(new_traceparent(), TRACEPARENT)
        self.assertEqual(
            trace_id_of("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"), "4bf92f3577b34da6a3ce929d0e0e4736"
        )

    def test_knows_the_apps_own_api_from_everywhere_else(self) -> None:
        self.assertTrue(is_api_call("/api/orders", "/api"))
        self.assertTrue(is_api_call("/api", "/api/"))
        self.assertFalse(is_api_call("/apiary", "/api"))
        self.assertTrue(is_api_call("https://api.example.com/orders", "https://api.example.com"))
        self.assertFalse(is_api_call("https://fonts.example.com/font.woff2", "https://api.example.com"))

    def test_starts_a_new_trace_for_each_call_to_the_api_and_for_no_other_call(self) -> None:
        first = with_trace("/api/orders", {"accept": "application/json"}, "/api")
        second = with_trace("/api/orders", {}, "/api")

        self.assertRegex(first["traceparent"], TRACEPARENT)
        self.assertEqual(first["accept"], "application/json")
        self.assertNotEqual(trace_id_of(first["traceparent"]), trace_id_of(second["traceparent"]))
        self.assertNotIn("traceparent", with_trace("/config.json", {}, "/api"))

    def test_keeps_a_trace_a_call_already_has(self) -> None:
        traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

        self.assertEqual(with_trace("/api/orders", {"Traceparent": traceparent}, "/api"), {"Traceparent": traceparent})


if __name__ == "__main__":
    unittest.main()
