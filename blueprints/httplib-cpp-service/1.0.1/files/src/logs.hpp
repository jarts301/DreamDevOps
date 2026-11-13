// Logs as one line of JSON each, on standard output, where the platform reads them.
//
// Each line says which trace it was written in, in trace_id and span_id, so the platform
// shows lines beside their trace. Log with logs::info("Order placed", {{"order", order_id}}).
#pragma once

#include <chrono>
#include <initializer_list>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

#include "json.hpp"

namespace logs {

// A field of a log line, such as {"order", 42}.
struct Field {
  std::string key;
  // The value, as JSON.
  std::string json;

  Field(std::string_view name, std::string_view value) : key(name), json(json::quote(value)) {}
  Field(std::string_view name, const char* value) : key(name), json(json::quote(value)) {}
  Field(std::string_view name, const std::string& value) : key(name), json(json::quote(value)) {}
  Field(std::string_view name, bool value) : key(name), json(value ? "true" : "false") {}
  template <typename Number>
    requires std::is_arithmetic_v<Number> && (!std::is_same_v<Number, bool>)
  Field(std::string_view name, Number value) : key(name), json(json::number(value)) {}
};

using Fields = std::initializer_list<Field>;

void info(std::string_view message, Fields fields = {});
void warn(std::string_view message, Fields fields = {});
void error(std::string_view message, Fields fields = {});

// Such as 2026-11-10T12:00:00.000Z.
std::string timestamp(std::chrono::system_clock::time_point time);

// Keeps the lines written while it exists, instead of writing them, for tests.
class Capture {
 public:
  Capture();
  ~Capture();
  Capture(const Capture&) = delete;
  Capture& operator=(const Capture&) = delete;

  // The lines written so far.
  std::vector<std::string> lines() const;
};

}  // namespace logs
