// Keeps what telemetry sends, instead of sending it, for tests to look at.
#pragma once

#include <mutex>
#include <string>
#include <vector>

#include "telemetry.hpp"

class Collector {
 public:
  telemetry::Send send() {
    return [this](const std::string& url, const std::string& body, std::string&) {
      const std::lock_guard lock(mutex_);
      received_.push_back(url + " " + body);
      return true;
    };
  }

  // Each body sent, after the URL it was sent to.
  std::vector<std::string> received() {
    const std::lock_guard lock(mutex_);
    return received_;
  }

  // Everything sent to URLs that end with a path, such as /v1/traces, as one text.
  std::string sent_to(const std::string& path) {
    std::string all;
    for (const auto& body : received()) {
      if (body.find(path + " ") != std::string::npos) all += body + "\n";
    }
    return all;
  }

 private:
  std::mutex mutex_;
  std::vector<std::string> received_;
};

inline telemetry::Settings sending_everything() {
  telemetry::Settings settings;
  settings.metrics_endpoint = "http://collector:4318/v1/metrics";
  settings.traces_endpoint = "http://collector:4318/v1/traces";
  settings.export_interval = std::chrono::hours(1);
  return settings;
}

inline bool contains(const std::string& text, const std::string& part) { return text.find(part) != std::string::npos; }
