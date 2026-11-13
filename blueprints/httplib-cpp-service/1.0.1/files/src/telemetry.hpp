// Sends metrics and traces over OTLP, as JSON, only when told where, with the standard OTEL_*
// variables. The platform sets the ones for metrics and traces, so it can show them on its dashboard.
#pragma once

#include <array>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <tuple>
#include <variant>
#include <vector>

#include "config.hpp"
#include "trace_context.hpp"

namespace telemetry {

// The name traces and metrics come under, unless OTEL_SERVICE_NAME says another.
inline constexpr std::string_view SERVICE_NAME = "__APP_SLUG__";

// What the service sends, and where.
struct Settings {
  // Where metrics go, or empty to send none. The platform asks for them, to show them on its dashboard.
  std::string metrics_endpoint;
  // Where traces go, or empty to send none.
  std::string traces_endpoint;
  std::chrono::milliseconds export_interval{15'000};
};

// Sends only what it's told where to send, so it sends nothing by default.
Settings settings(const Env& env);

// An attribute of a span, a metric or the service itself.
struct Attribute {
  std::string key;
  std::variant<std::string, std::int64_t> value;
  bool operator==(const Attribute&) const = default;
};

// What describes the service, in every metric and trace: its name, and the attributes in
// OTEL_RESOURCE_ATTRIBUTES, where the platform adds the environment's ID.
std::vector<Attribute> resource(const Env& env);

// Posts JSON to a URL, and says whether it arrived, or why not.
using Send = std::function<bool(const std::string& url, const std::string& body, std::string& problem)>;

// Posts JSON over HTTP.
bool post_json(const std::string& url, const std::string& body, std::string& problem);

// CPU time used so far, in seconds, in user and system mode, and memory held in RAM, in bytes.
struct ProcessUsage {
  double user_cpu = 0;
  double system_cpu = 0;
  std::int64_t memory = 0;
};

ProcessUsage process_usage();

// The platform checks health every few seconds. That isn't traffic, so it isn't logged, traced or measured.
bool is_health_check(std::string_view path);

// A request being answered, within its span.
struct ObservedRequest {
  SpanContext span;
  std::optional<SpanContext> caller;
  std::string method;
  std::string path;
  std::chrono::system_clock::time_point started;
  std::chrono::steady_clock::time_point started_steady;
};

// Traces and measures each request the service answers, logs it, measures CPU and memory, and
// sends what's asked for from a thread of its own.
class Telemetry {
 public:
  Telemetry(Settings settings, std::vector<Attribute> resource, Send send = post_json);
  ~Telemetry();
  Telemetry(const Telemetry&) = delete;
  Telemetry& operator=(const Telemetry&) = delete;

  // Starts a request's span, continuing the trace in its traceparent header, unless it's a health check.
  std::optional<ObservedRequest> start_request(std::string method, std::string path, std::string_view traceparent);

  // Ends a request's span, measures how long it took, and logs it. route is the route it
  // matched, such as /api/hello, or empty when none did.
  void finish_request(const ObservedRequest& request, std::string_view route, int status);

  // Sends everything waiting now, rather than when it's due.
  void flush();

  // Sends anything still waiting, and stops sending, before the process stops.
  void shutdown();

 private:
  struct Span {
    SpanContext context;
    std::optional<SpanContext> parent;
    std::string name;
    std::chrono::system_clock::time_point start;
    std::chrono::system_clock::time_point end;
    std::vector<Attribute> attributes;
    bool failed = false;
  };
  struct Histogram {
    std::array<std::uint64_t, 15> buckets{};
    std::uint64_t count = 0;
    double sum = 0;
    double min = 0;
    double max = 0;
  };
  // The method, route and status of requests, which they're measured by.
  using RequestKind = std::tuple<std::string, std::string, int>;

  void run();
  void send_spans(std::vector<Span> spans);
  void send_metrics();
  void sent(std::string_view what, bool ok, const std::string& problem);

  const Settings settings_;
  const std::string resource_json_;
  const Send send_;
  const std::chrono::system_clock::time_point started_ = std::chrono::system_clock::now();

  std::mutex mutex_;
  std::condition_variable wake_;
  std::vector<Span> spans_;
  std::map<RequestKind, Histogram> durations_;
  bool stopping_ = false;
  std::map<std::string, bool, std::less<>> failing_;
  std::mutex sending_;
  std::thread thread_;
};

}  // namespace telemetry
