#include <doctest.h>

#include <cmath>

#include "json.hpp"

TEST_CASE("quotes text, escaping what JSON needs escaped") {
  CHECK(json::quote("Ada") == R"("Ada")");
  CHECK(json::quote("say \"hi\"\\\n") == R"("say \"hi\"\\\n")");
  CHECK(json::quote(std::string("\x01", 1)) == R"("\u0001")");
  CHECK(json::quote("José") == "\"José\"");
}

TEST_CASE("builds objects of every kind of value") {
  const auto object = json::Object().add("text", "a").add("count", 3).add("ratio", 0.5).add("ok", true);
  CHECK(object.str() == R"({"text":"a","count":3,"ratio":0.5,"ok":true})");
  CHECK(json::Object().str() == "{}");
}

TEST_CASE("writes numbers JSON can't hold as null") {
  CHECK(json::number(std::nan("")) == "null");
  CHECK(json::number(1e300 * 1e300) == "null");
}

TEST_CASE("builds arrays") {
  CHECK(json::array({}) == "[]");
  CHECK(json::array({"1", R"("a")"}) == R"([1,"a"])");
}
