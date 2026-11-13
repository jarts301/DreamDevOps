#include <doctest.h>

#include "trace_context.hpp"

TEST_CASE("reads the trace a caller started from its traceparent header") {
  const auto span = parse_traceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  REQUIRE(span);
  CHECK(span->trace_id_hex() == "4bf92f3577b34da6a3ce929d0e0e4736");
  CHECK(span->span_id_hex() == "00f067aa0ba902b7");
  CHECK(span->sampled);
}

TEST_CASE("ignores a traceparent header that isn't valid") {
  for (const auto* header : {"", "garbage", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7",
                             "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
                             "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
                             "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                             "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
                             "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra"}) {
    CAPTURE(header);
    CHECK_FALSE(parse_traceparent(header));
  }
}

TEST_CASE("continues the caller's trace, in a span of its own") {
  const auto caller = parse_traceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00");
  const auto span = new_span(caller);
  CHECK(span.trace_id == caller->trace_id);
  CHECK(span.span_id != caller->span_id);
  CHECK_FALSE(span.sampled);
}

TEST_CASE("starts a new trace, which is kept, when there's no caller") {
  const auto first = new_span(std::nullopt);
  const auto second = new_span(std::nullopt);
  CHECK(first.valid());
  CHECK(first.sampled);
  CHECK(first.trace_id != second.trace_id);
}
