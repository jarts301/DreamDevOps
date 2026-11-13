#include "trace_context.hpp"

#include <algorithm>
#include <random>

namespace {

thread_local std::optional<SpanContext> current;

template <std::size_t Size>
std::string hex(const std::array<std::uint8_t, Size>& bytes) {
  constexpr std::string_view digits = "0123456789abcdef";
  std::string out;
  out.reserve(Size * 2);
  for (const auto byte : bytes) {
    out += digits[byte >> 4];
    out += digits[byte & 0xf];
  }
  return out;
}

int digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;  // W3C Trace Context only allows lowercase.
}

template <std::size_t Size>
bool parse_hex(std::string_view text, std::array<std::uint8_t, Size>& bytes) {
  if (text.size() != Size * 2) return false;
  for (std::size_t i = 0; i < Size; ++i) {
    const int high = digit(text[i * 2]);
    const int low = digit(text[i * 2 + 1]);
    if (high < 0 || low < 0) return false;
    bytes[i] = static_cast<std::uint8_t>(high * 16 + low);
  }
  return true;
}

template <std::size_t Size>
bool all_zero(const std::array<std::uint8_t, Size>& bytes) {
  return std::all_of(bytes.begin(), bytes.end(), [](std::uint8_t byte) { return byte == 0; });
}

template <std::size_t Size>
void randomize(std::array<std::uint8_t, Size>& bytes) {
  thread_local std::mt19937_64 random{std::random_device{}()};
  do {
    for (auto& byte : bytes) byte = static_cast<std::uint8_t>(random());
  } while (all_zero(bytes));
}

}  // namespace

bool SpanContext::valid() const { return !all_zero(trace_id) && !all_zero(span_id); }

std::string SpanContext::trace_id_hex() const { return hex(trace_id); }

std::string SpanContext::span_id_hex() const { return hex(span_id); }

std::optional<SpanContext> parse_traceparent(std::string_view header) {
  // version-trace_id-span_id-flags, each in lowercase hex.
  if (header.size() < 55 || header[2] != '-' || header[35] != '-' || header[52] != '-') return std::nullopt;
  std::array<std::uint8_t, 1> version{};
  std::array<std::uint8_t, 1> flags{};
  SpanContext span;
  if (!parse_hex(header.substr(0, 2), version) || version[0] == 0xff ||
      !parse_hex(header.substr(3, 32), span.trace_id) || !parse_hex(header.substr(36, 16), span.span_id) ||
      !parse_hex(header.substr(53, 2), flags)) {
    return std::nullopt;
  }
  // Version 00 has nothing more. Later versions may add fields, after another dash.
  if (header.size() > 55 && (version[0] == 0 || header[55] != '-')) return std::nullopt;
  span.sampled = (flags[0] & 1) != 0;
  if (!span.valid()) return std::nullopt;
  return span;
}

SpanContext new_span(const std::optional<SpanContext>& parent) {
  SpanContext span;
  if (parent) {
    span.trace_id = parent->trace_id;
    span.sampled = parent->sampled;
  } else {
    randomize(span.trace_id);
    span.sampled = true;
  }
  randomize(span.span_id);
  return span;
}

std::optional<SpanContext> current_span() { return current; }

void set_current_span(const std::optional<SpanContext>& span) { current = span; }

ScopedSpan::ScopedSpan(const SpanContext& span) : previous_(current) { current = span; }

ScopedSpan::~ScopedSpan() { current = previous_; }
