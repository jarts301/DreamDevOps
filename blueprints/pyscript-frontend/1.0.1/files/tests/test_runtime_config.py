import unittest

from runtime_config import Settings, settings_from


class RuntimeConfigTest(unittest.TestCase):
    def test_reads_where_the_api_is(self) -> None:
        self.assertEqual(
            settings_from('{"apiUrl": "https://api.example.com"}'), Settings(api_url="https://api.example.com")
        )

    def test_calls_the_api_at_slash_api_unless_they_say_otherwise(self) -> None:
        for text in ["{}", '{"apiUrl": ""}', '{"apiUrl": 42}', "[]"]:
            self.assertEqual(settings_from(text), Settings(api_url="/api"), text)


if __name__ == "__main__":
    unittest.main()
