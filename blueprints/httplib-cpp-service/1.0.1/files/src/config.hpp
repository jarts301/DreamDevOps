// Reads the service's settings from environment variables, so one image runs in every environment.
#pragma once

#include <cstdint>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

using Env = std::map<std::string, std::string>;

// The service's settings.
struct Config {
  std::string host = "0.0.0.0";
  std::uint16_t port = 8080;
  // Web pages at these origins may call the service from browsers, such as https://shop.example.com.
  std::vector<std::string> cors_origins;
};

// A setting that isn't valid, and why.
class ConfigError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

// The settings in these environment variables. Throws ConfigError when one isn't valid.
Config load_config(const Env& env);

// The process's environment variables.
Env process_env();
