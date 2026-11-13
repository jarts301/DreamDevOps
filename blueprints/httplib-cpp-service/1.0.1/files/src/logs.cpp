#include "logs.hpp"

#include <ctime>
#include <iostream>
#include <mutex>
#include <optional>

#include "trace_context.hpp"

namespace logs {
namespace {

std::mutex output;
// The lines a Capture keeps, while one exists.
std::optional<std::vector<std::string>> captured;

void write(std::string_view level, std::string_view message, Fields fields) {
  json::Object line;
  line.add("time", timestamp(std::chrono::system_clock::now())).add("level", level).add("msg", message);
  line.add("logger", "service");
  if (const auto span = current_span()) {
    line.add("trace_id", span->trace_id_hex()).add("span_id", span->span_id_hex()).add("trace_flags", span->flags_hex());
  }
  for (const auto& field : fields) line.raw(field.key, field.json);
  const std::lock_guard lock(output);
  if (captured) {
    captured->push_back(line.str());
  } else {
    std::cout << line.str() << '\n' << std::flush;
  }
}

}  // namespace

void info(std::string_view message, Fields fields) { write("info", message, fields); }
void warn(std::string_view message, Fields fields) { write("warn", message, fields); }
void error(std::string_view message, Fields fields) { write("error", message, fields); }

std::string timestamp(std::chrono::system_clock::time_point time) {
  const auto since_epoch = time.time_since_epoch();
  const auto seconds = std::chrono::duration_cast<std::chrono::seconds>(since_epoch);
  const auto millis = std::chrono::duration_cast<std::chrono::milliseconds>(since_epoch - seconds).count();
  const std::time_t whole = static_cast<std::time_t>(seconds.count());
  std::tm utc{};
  gmtime_r(&whole, &utc);
  char text[32];
  const auto length = std::strftime(text, sizeof text, "%Y-%m-%dT%H:%M:%S", &utc);
  char fraction[8];
  std::snprintf(fraction, sizeof fraction, ".%03dZ", static_cast<int>(millis));
  return std::string(text, length) + fraction;
}

Capture::Capture() {
  const std::lock_guard lock(output);
  captured.emplace();
}

Capture::~Capture() {
  const std::lock_guard lock(output);
  captured.reset();
}

std::vector<std::string> Capture::lines() const {
  const std::lock_guard lock(output);
  return captured ? *captured : std::vector<std::string>{};
}

}  // namespace logs
