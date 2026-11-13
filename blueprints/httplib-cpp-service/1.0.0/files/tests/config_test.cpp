#include <doctest.h>

#include "config.hpp"

TEST_CASE("uses port 8080 on every network interface by default, and lets no web page call it") {
  const auto config = load_config({});
  CHECK(config.host == "0.0.0.0");
  CHECK(config.port == 8080);
  CHECK(config.cors_origins.empty());
}

TEST_CASE("reads the host and port") {
  const auto config = load_config({{"HOST", "127.0.0.1"}, {"PORT", "3000"}});
  CHECK(config.host == "127.0.0.1");
  CHECK(config.port == 3000);
}

TEST_CASE("refuses a port that isn't valid") {
  for (const auto* port : {"eighty", "0", "70000", "-1", "80a", ""}) {
    CAPTURE(port);
    CHECK_THROWS_WITH_AS(load_config({{"PORT", port}}), "PORT must be a whole number between 1 and 65535.",
                         ConfigError);
  }
}

TEST_CASE("lets the web pages it lists call it") {
  const auto config = load_config({{"CORS_ORIGINS", " https://shop.example.com, http://localhost:49154 ,"}});
  CHECK(config.cors_origins == std::vector<std::string>{"https://shop.example.com", "http://localhost:49154"});
}

TEST_CASE("refuses something that isn't an origin") {
  for (const auto* value : {"*", "shop.example.com", "https://shop.example.com/path", "https://", "http://host:"}) {
    CAPTURE(value);
    CHECK_THROWS_AS(load_config({{"CORS_ORIGINS", value}}), ConfigError);
  }
}
