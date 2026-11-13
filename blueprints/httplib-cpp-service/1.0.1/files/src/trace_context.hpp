// Which trace and span the code runs in, so log lines and spans say which trace they're part of.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

// A span of a trace, with W3C Trace Context's IDs.
struct SpanContext {
  std::array<std::uint8_t, 16> trace_id{};
  std::array<std::uint8_t, 8> span_id{};
  // Whether the trace is kept, and so sent.
  bool sampled = false;

  bool valid() const;
  std::string trace_id_hex() const;
  std::string span_id_hex() const;
  std::string flags_hex() const { return sampled ? "01" : "00"; }
};

// The span a W3C traceparent header, such as 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01,
// says its caller is in, or nothing, if it isn't valid.
std::optional<SpanContext> parse_traceparent(std::string_view header);

// A new span: in the given trace, or in a new one, which is kept.
SpanContext new_span(const std::optional<SpanContext>& parent);

// The span the code on this thread runs in, if any.
std::optional<SpanContext> current_span();

// Makes a span the current one on this thread, or none.
void set_current_span(const std::optional<SpanContext>& span);

// Makes a span the current one on this thread, until it's destroyed.
class ScopedSpan {
 public:
  explicit ScopedSpan(const SpanContext& span);
  ~ScopedSpan();
  ScopedSpan(const ScopedSpan&) = delete;
  ScopedSpan& operator=(const ScopedSpan&) = delete;

 private:
  std::optional<SpanContext> previous_;
};
