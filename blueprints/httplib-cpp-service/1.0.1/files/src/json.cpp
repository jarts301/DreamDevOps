#include "json.hpp"

#include <array>
#include <charconv>
#include <cmath>

namespace json {

std::string quote(std::string_view text) {
  std::string out;
  out.reserve(text.size() + 2);
  out += '"';
  for (const char c : text) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          constexpr std::string_view hex = "0123456789abcdef";
          out += "\\u00";
          out += hex[static_cast<unsigned char>(c) >> 4];
          out += hex[static_cast<unsigned char>(c) & 0xf];
        } else {
          out += c;
        }
    }
  }
  out += '"';
  return out;
}

Object& Object::raw(std::string_view key, std::string_view json) {
  if (!members_.empty()) members_ += ',';
  members_ += quote(key);
  members_ += ':';
  members_ += json;
  return *this;
}

std::string array(const std::vector<std::string>& items) {
  std::string out = "[";
  for (const auto& item : items) {
    if (out.size() > 1) out += ',';
    out += item;
  }
  return out + "]";
}

std::string real(double value) {
  if (!std::isfinite(value)) return "null";
  std::array<char, 32> buffer{};
  const auto [end, error] = std::to_chars(buffer.data(), buffer.data() + buffer.size(), value);
  return std::string(buffer.data(), end);
}

}  // namespace json
