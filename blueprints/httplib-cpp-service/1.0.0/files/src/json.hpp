// Writes JSON, for responses, log lines and telemetry. The service only ever writes JSON, so
// this is all it needs.
#pragma once

#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

namespace json {

// A JSON string, with quotes, escaped as RFC 8259 says.
std::string quote(std::string_view text);

// A number with a fraction as JSON. Numbers JSON can't hold, such as infinity, are written as null.
std::string real(double value);

// A number as JSON.
template <typename Number>
  requires std::is_arithmetic_v<Number> && (!std::is_same_v<Number, bool>)
std::string number(Number value) {
  if constexpr (std::is_floating_point_v<Number>) {
    return real(static_cast<double>(value));
  } else {
    return std::to_string(value);
  }
}

// A JSON array of values that are already JSON.
std::string array(const std::vector<std::string>& items);

// A JSON object, built one member at a time, such as
// json::Object().add("status", "ok").add("count", 3).str().
class Object {
 public:
  Object& add(std::string_view key, std::string_view value) { return raw(key, quote(value)); }
  Object& add(std::string_view key, const char* value) { return raw(key, quote(value)); }
  Object& add(std::string_view key, const std::string& value) { return raw(key, quote(value)); }
  Object& add(std::string_view key, bool value) { return raw(key, value ? "true" : "false"); }
  template <typename Number>
    requires std::is_arithmetic_v<Number> && (!std::is_same_v<Number, bool>)
  Object& add(std::string_view key, Number value) {
    return raw(key, number(value));
  }
  // Adds a value that's already JSON, such as another object.
  Object& raw(std::string_view key, std::string_view json);
  bool empty() const { return members_.empty(); }
  std::string str() const { return "{" + members_ + "}"; }

 private:
  std::string members_;
};

}  // namespace json
