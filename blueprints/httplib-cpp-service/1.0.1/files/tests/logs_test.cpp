#include <doctest.h>

#include "logs.hpp"
#include "trace_context.hpp"

TEST_CASE("writes one line of JSON with the message, level and fields") {
  const logs::Capture logs;
  logs::info("Order placed", {{"order", 42}, {"customer", "Ada"}});
  const auto line = logs.lines().at(0);
  CHECK(line.starts_with(R"({"time":")"));
  CHECK(line.find(R"("level":"info","msg":"Order placed")") != std::string::npos);
  CHECK(line.find(R"("order":42,"customer":"Ada")") != std::string::npos);
  CHECK(line.find("trace_id") == std::string::npos);
}

TEST_CASE("says which trace and span a line was written in") {
  const logs::Capture logs;
  const auto span = parse_traceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  {
    const ScopedSpan current(*span);
    logs::info("Ping received");
  }
  logs::info("Later");
  const auto lines = logs.lines();
  CHECK(lines.at(0).find(R"("trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7",)"
                         R"("trace_flags":"01")") != std::string::npos);
  CHECK(lines.at(1).find("trace_id") == std::string::npos);
}

TEST_CASE("writes times in UTC, to the millisecond") {
  const auto time = std::chrono::system_clock::time_point(std::chrono::milliseconds(1'794'312'000'123));
  CHECK(logs::timestamp(time) == "2026-11-10T12:00:00.123Z");
}
