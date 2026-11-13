#include "config.hpp"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <string_view>

extern char** environ;

namespace {

std::string get(const Env& env, const std::string& name, std::string fallback = "") {
  const auto found = env.find(name);
  return found == env.end() ? fallback : found->second;
}

std::string_view trim(std::string_view text) {
  while (!text.empty() && std::isspace(static_cast<unsigned char>(text.front()))) text.remove_prefix(1);
  while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back()))) text.remove_suffix(1);
  return text;
}

// Such as https://shop.example.com or http://localhost:49154: a scheme, a host and maybe a port.
bool is_origin(std::string_view value) {
  std::string_view rest;
  if (value.starts_with("https://")) {
    rest = value.substr(8);
  } else if (value.starts_with("http://")) {
    rest = value.substr(7);
  } else {
    return false;
  }
  const auto colon = rest.find(':');
  const auto host = rest.substr(0, colon);
  const auto is_host_char = [](char c) { return std::isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '-'; };
  if (host.empty() || !std::all_of(host.begin(), host.end(), is_host_char)) return false;
  if (colon == std::string_view::npos) return true;
  const auto port = rest.substr(colon + 1);
  const auto is_digit = [](char c) { return std::isdigit(static_cast<unsigned char>(c)) != 0; };
  return !port.empty() && port.size() <= 5 && std::all_of(port.begin(), port.end(), is_digit);
}

}  // namespace

Config load_config(const Env& env) {
  Config config;
  const auto port = get(env, "PORT", "8080");
  unsigned value = 0;
  const auto [end, error] = std::from_chars(port.data(), port.data() + port.size(), value);
  if (error != std::errc() || end != port.data() + port.size() || value < 1 || value > 65535) {
    throw ConfigError("PORT must be a whole number between 1 and 65535.");
  }
  config.port = static_cast<std::uint16_t>(value);
  config.host = get(env, "HOST", config.host);
  const std::string origins = get(env, "CORS_ORIGINS");
  std::string_view rest = origins;
  while (!rest.empty()) {
    const auto comma = rest.find(',');
    const auto origin = trim(rest.substr(0, comma));
    rest = comma == std::string_view::npos ? std::string_view() : rest.substr(comma + 1);
    if (origin.empty()) continue;
    if (!is_origin(origin)) {
      throw ConfigError("CORS_ORIGINS must list origins such as https://shop.example.com, and \"" +
                        std::string(origin) + "\" isn't one.");
    }
    config.cors_origins.emplace_back(origin);
  }
  return config;
}

Env process_env() {
  Env env;
  for (char** variable = environ; *variable != nullptr; ++variable) {
    const std::string_view entry(*variable);
    const auto equals = entry.find('=');
    if (equals != std::string_view::npos) env.emplace(entry.substr(0, equals), entry.substr(equals + 1));
  }
  return env;
}
