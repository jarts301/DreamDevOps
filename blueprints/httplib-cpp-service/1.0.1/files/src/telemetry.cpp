#include "telemetry.hpp"

#include <sys/resource.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <httplib.h>

#include "json.hpp"
#include "logs.hpp"

namespace telemetry {
namespace {

using std::chrono::system_clock;

// The buckets of response times, in seconds, that OpenTelemetry recommends for HTTP.
constexpr std::array<double, 14> DURATION_BUCKETS = {0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25,
                                                     0.5,   0.75, 1.0,   2.5,  5.0,   7.5, 10.0};
// How often waiting spans are sent, and how many are sent sooner, or kept at most.
constexpr auto SPAN_DELAY = std::chrono::seconds(2);
constexpr std::size_t SPAN_BATCH = 512;
constexpr std::size_t SPAN_LIMIT = 2048;

// OTLP's span kind for a request the service answers, and its status for one that failed.
constexpr int SPAN_KIND_SERVER = 2;
constexpr int STATUS_ERROR = 2;
// Metrics add up since the service started, rather than since they were last sent.
constexpr int CUMULATIVE = 2;

std::string get(const Env& env, const std::string& name) {
  const auto found = env.find(name);
  return found == env.end() ? "" : found->second;
}

// Where one kind of telemetry goes: its own variable, or the shared one, with the kind's path added.
std::string endpoint(const Env& env, const std::string& own, std::string_view path) {
  if (auto url = get(env, own); !url.empty()) return url;
  auto url = get(env, "OTEL_EXPORTER_OTLP_ENDPOINT");
  if (url.empty()) return url;
  while (url.ends_with('/')) url.pop_back();
  return url + std::string(path);
}

std::string nanos(system_clock::time_point time) {
  return std::to_string(std::chrono::duration_cast<std::chrono::nanoseconds>(time.time_since_epoch()).count());
}

std::string attribute_json(const Attribute& attribute) {
  json::Object value;
  if (const auto* text = std::get_if<std::string>(&attribute.value)) {
    value.add("stringValue", *text);
  } else {
    // OTLP's JSON holds 64-bit integers as strings.
    value.add("intValue", std::to_string(std::get<std::int64_t>(attribute.value)));
  }
  return json::Object().add("key", attribute.key).raw("value", value.str()).str();
}

std::string attributes_json(const std::vector<Attribute>& attributes) {
  std::vector<std::string> items;
  for (const auto& attribute : attributes) items.push_back(attribute_json(attribute));
  return json::array(items);
}

std::string scope_json() { return json::Object().add("name", SERVICE_NAME).str(); }

std::string percent_decoded(std::string_view text) {
  std::string out;
  for (std::size_t i = 0; i < text.size(); ++i) {
    if (text[i] == '%' && i + 2 < text.size()) {
      const auto hex = std::string(text.substr(i + 1, 2));
      char* end = nullptr;
      const auto value = std::strtol(hex.c_str(), &end, 16);
      if (end == hex.c_str() + 2) {
        out += static_cast<char>(value);
        i += 2;
        continue;
      }
    }
    out += text[i];
  }
  return out;
}

std::string_view trim(std::string_view text) {
  while (!text.empty() && text.front() == ' ') text.remove_prefix(1);
  while (!text.empty() && text.back() == ' ') text.remove_suffix(1);
  return text;
}

}  // namespace

Settings settings(const Env& env) {
  Settings settings;
  settings.metrics_endpoint = endpoint(env, "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "/v1/metrics");
  settings.traces_endpoint = endpoint(env, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "/v1/traces");
  const auto interval = get(env, "OTEL_METRIC_EXPORT_INTERVAL");
  if (!interval.empty() && std::all_of(interval.begin(), interval.end(), [](char c) { return c >= '0' && c <= '9'; }) &&
      interval.size() < 10) {
    if (const auto ms = std::stol(interval); ms > 0) settings.export_interval = std::chrono::milliseconds(ms);
  }
  return settings;
}

std::vector<Attribute> resource(const Env& env) {
  auto name = get(env, "OTEL_SERVICE_NAME");
  std::vector<Attribute> attributes = {{"service.name", name.empty() ? std::string(SERVICE_NAME) : name}};
  // Such as team=shop,dreamdevops.environment.id=42, with values percent-encoded.
  const auto listed = get(env, "OTEL_RESOURCE_ATTRIBUTES");
  std::string_view rest = listed;
  while (!rest.empty()) {
    const auto comma = rest.find(',');
    const auto pair = rest.substr(0, comma);
    rest = comma == std::string_view::npos ? std::string_view() : rest.substr(comma + 1);
    const auto equals = pair.find('=');
    if (equals == std::string_view::npos) continue;
    const auto key = std::string(trim(pair.substr(0, equals)));
    // OTEL_SERVICE_NAME, when it's set, names the service, rather than these.
    if (key.empty() || (key == "service.name" && !name.empty())) continue;
    const auto value = percent_decoded(trim(pair.substr(equals + 1)));
    const auto same = [&](const Attribute& attribute) { return attribute.key == key; };
    attributes.erase(std::remove_if(attributes.begin(), attributes.end(), same), attributes.end());
    attributes.push_back({key, value});
  }
  return attributes;
}

bool post_json(const std::string& url, const std::string& body, std::string& problem) {
  const auto scheme = url.find("://");
  if (scheme == std::string::npos) {
    problem = url + " isn't a URL";
    return false;
  }
  const auto path = url.find('/', scheme + 3);
  httplib::Client client(url.substr(0, path));
  if (!client.is_valid()) {
    problem = url + " can't be reached, as only http:// addresses are supported";
    return false;
  }
  client.set_connection_timeout(std::chrono::seconds(5));
  client.set_read_timeout(std::chrono::seconds(10));
  client.set_write_timeout(std::chrono::seconds(10));
  const auto result = client.Post(path == std::string::npos ? "/" : url.substr(path), body, "application/json");
  if (!result) {
    problem = httplib::to_string(result.error());
    return false;
  }
  if (result->status >= 300) {
    problem = "the answer was " + std::to_string(result->status);
    return false;
  }
  return true;
}

ProcessUsage process_usage() {
  ProcessUsage usage;
  rusage used{};
  if (getrusage(RUSAGE_SELF, &used) == 0) {
    const auto seconds = [](const timeval& time) {
      return static_cast<double>(time.tv_sec) + static_cast<double>(time.tv_usec) / 1e6;
    };
    usage.user_cpu = seconds(used.ru_utime);
    usage.system_cpu = seconds(used.ru_stime);
  }
  // The container runs on Linux, which says what's in RAM now. Elsewhere, such as while
  // developing on a Mac, there's nothing to report.
  std::ifstream status("/proc/self/status");
  for (std::string line; std::getline(status, line);) {
    if (line.starts_with("VmRSS:")) {
      usage.memory = std::stoll(line.substr(6)) * 1024;
      break;
    }
  }
  return usage;
}

bool is_health_check(std::string_view path) { return path.starts_with("/health/"); }

Telemetry::Telemetry(Settings settings, std::vector<Attribute> resource, Send send)
    : settings_(std::move(settings)),
      resource_json_(json::Object().raw("attributes", attributes_json(resource)).str()),
      send_(std::move(send)) {
  if (!settings_.metrics_endpoint.empty() || !settings_.traces_endpoint.empty()) {
    thread_ = std::thread([this] { run(); });
  }
}

Telemetry::~Telemetry() { shutdown(); }

std::optional<ObservedRequest> Telemetry::start_request(std::string method, std::string path,
                                                        std::string_view traceparent) {
  if (is_health_check(path)) return std::nullopt;
  ObservedRequest request;
  request.caller = parse_traceparent(traceparent);
  request.span = new_span(request.caller);
  request.method = std::move(method);
  request.path = std::move(path);
  request.started = system_clock::now();
  request.started_steady = std::chrono::steady_clock::now();
  return request;
}

void Telemetry::finish_request(const ObservedRequest& request, std::string_view route, int status) {
  const std::chrono::duration<double> took = std::chrono::steady_clock::now() - request.started_steady;
  const auto seconds = took.count();
  logs::info("request completed", {{"method", request.method},
                                   {"path", request.path},
                                   {"status", status},
                                   {"duration_ms", std::round(seconds * 1e6) / 1e3}});
  Span span{request.span, request.caller, request.method, request.started, system_clock::now(), {}, status >= 500};
  span.attributes = {{"http.request.method", request.method},
                     {"url.path", request.path},
                     {"http.response.status_code", std::int64_t{status}}};
  if (!route.empty()) {
    span.name += " " + std::string(route);
    span.attributes.push_back({"http.route", std::string(route)});
  }
  const std::lock_guard lock(mutex_);
  if (!settings_.metrics_endpoint.empty()) {
    auto& histogram = durations_[{request.method, std::string(route), status}];
    const auto bucket = std::lower_bound(DURATION_BUCKETS.begin(), DURATION_BUCKETS.end(), seconds);
    histogram.buckets.at(static_cast<std::size_t>(bucket - DURATION_BUCKETS.begin()))++;
    histogram.min = histogram.count == 0 ? seconds : std::min(histogram.min, seconds);
    histogram.max = histogram.count == 0 ? seconds : std::max(histogram.max, seconds);
    histogram.count++;
    histogram.sum += seconds;
  }
  if (!settings_.traces_endpoint.empty() && request.span.sampled && spans_.size() < SPAN_LIMIT) {
    spans_.push_back(std::move(span));
    if (spans_.size() >= SPAN_BATCH) wake_.notify_one();
  }
}

void Telemetry::run() {
  auto next_spans = std::chrono::steady_clock::now() + SPAN_DELAY;
  auto next_metrics = std::chrono::steady_clock::now() + settings_.export_interval;
  std::unique_lock lock(mutex_);
  while (!stopping_) {
    wake_.wait_until(lock, std::min(next_spans, next_metrics),
                     [this] { return stopping_ || spans_.size() >= SPAN_BATCH; });
    if (stopping_) break;
    const auto now = std::chrono::steady_clock::now();
    if (now >= next_spans || spans_.size() >= SPAN_BATCH) {
      auto spans = std::move(spans_);
      spans_.clear();
      lock.unlock();
      send_spans(std::move(spans));
      lock.lock();
      next_spans = now + SPAN_DELAY;
    }
    if (now >= next_metrics) {
      lock.unlock();
      send_metrics();
      lock.lock();
      next_metrics = now + settings_.export_interval;
    }
  }
}

void Telemetry::flush() {
  std::vector<Span> spans;
  {
    const std::lock_guard lock(mutex_);
    spans = std::move(spans_);
    spans_.clear();
  }
  send_spans(std::move(spans));
  send_metrics();
}

void Telemetry::shutdown() {
  {
    const std::lock_guard lock(mutex_);
    if (stopping_) return;
    stopping_ = true;
  }
  wake_.notify_one();
  if (thread_.joinable()) thread_.join();
  flush();
}

void Telemetry::send_spans(std::vector<Span> spans) {
  if (spans.empty() || settings_.traces_endpoint.empty()) return;
  std::vector<std::string> items;
  for (const auto& span : spans) {
    json::Object item;
    item.add("traceId", span.context.trace_id_hex()).add("spanId", span.context.span_id_hex());
    if (span.parent) item.add("parentSpanId", span.parent->span_id_hex());
    item.add("name", span.name).add("kind", SPAN_KIND_SERVER);
    item.add("startTimeUnixNano", nanos(span.start)).add("endTimeUnixNano", nanos(span.end));
    item.raw("attributes", attributes_json(span.attributes));
    if (span.failed) item.raw("status", json::Object().add("code", STATUS_ERROR).str());
    items.push_back(item.str());
  }
  const auto scope = json::Object().raw("scope", scope_json()).raw("spans", json::array(items)).str();
  const auto resource = json::Object().raw("resource", resource_json_).raw("scopeSpans", json::array({scope})).str();
  const auto body = json::Object().raw("resourceSpans", json::array({resource})).str();
  const std::lock_guard lock(sending_);
  std::string problem;
  const auto ok = send_(settings_.traces_endpoint, body, problem);
  sent("traces", ok, problem);
}

void Telemetry::send_metrics() {
  if (settings_.metrics_endpoint.empty()) return;
  const auto start = nanos(started_);
  const auto now = nanos(system_clock::now());
  const auto point = [&](std::vector<Attribute> attributes) {
    json::Object item;
    if (!attributes.empty()) item.raw("attributes", attributes_json(attributes));
    item.add("startTimeUnixNano", start).add("timeUnixNano", now);
    return item;
  };
  const auto usage = process_usage();
  const auto cpu = json::array({point({{"cpu.mode", "user"}}).add("asDouble", usage.user_cpu).str(),
                                point({{"cpu.mode", "system"}}).add("asDouble", usage.system_cpu).str()});
  const auto memory = json::array({point({}).add("asInt", std::to_string(usage.memory)).str()});
  std::vector<std::string> requests;
  {
    const std::lock_guard lock(mutex_);
    for (const auto& [kind, histogram] : durations_) {
      const auto& [method, route, status] = kind;
      std::vector<Attribute> attributes = {{"http.request.method", method},
                                           {"http.response.status_code", std::int64_t{status}}};
      if (!route.empty()) attributes.push_back({"http.route", route});
      std::vector<std::string> counts;
      for (const auto count : histogram.buckets) counts.push_back(json::quote(std::to_string(count)));
      std::vector<std::string> bounds;
      for (const auto bound : DURATION_BUCKETS) bounds.push_back(json::number(bound));
      requests.push_back(point(attributes)
                             .add("count", std::to_string(histogram.count))
                             .add("sum", histogram.sum)
                             .add("min", histogram.min)
                             .add("max", histogram.max)
                             .raw("bucketCounts", json::array(counts))
                             .raw("explicitBounds", json::array(bounds))
                             .str());
    }
  }
  const auto sum = [](const std::string& points, bool monotonic) {
    return json::Object()
        .add("aggregationTemporality", CUMULATIVE)
        .add("isMonotonic", monotonic)
        .raw("dataPoints", points)
        .str();
  };
  std::vector<std::string> metrics = {
      json::Object()
          .add("name", "process.cpu.time")
          .add("unit", "s")
          .add("description", "CPU time the process has used.")
          .raw("sum", sum(cpu, true))
          .str(),
      json::Object()
          .add("name", "process.memory.usage")
          .add("unit", "By")
          .add("description", "Memory the process holds in RAM.")
          .raw("sum", sum(memory, false))
          .str()};
  if (!requests.empty()) {
    metrics.push_back(json::Object()
                          .add("name", "http.server.request.duration")
                          .add("unit", "s")
                          .add("description", "How long each request took to answer.")
                          .raw("histogram", json::Object()
                                                .add("aggregationTemporality", CUMULATIVE)
                                                .raw("dataPoints", json::array(requests))
                                                .str())
                          .str());
  }
  const auto scope = json::Object().raw("scope", scope_json()).raw("metrics", json::array(metrics)).str();
  const auto resource =
      json::Object().raw("resource", resource_json_).raw("scopeMetrics", json::array({scope})).str();
  const auto body = json::Object().raw("resourceMetrics", json::array({resource})).str();
  const std::lock_guard lock(sending_);
  std::string problem;
  const auto ok = send_(settings_.metrics_endpoint, body, problem);
  sent("metrics", ok, problem);
}

// Logs when sending starts failing, and when it works again, rather than each time.
void Telemetry::sent(std::string_view what, bool ok, const std::string& problem) {
  auto& failing = failing_[std::string(what)];
  if (!ok && !failing) logs::warn("Telemetry can't be sent", {{"telemetry", what}, {"error", problem}});
  if (ok && failing) logs::info("Telemetry is sent again", {{"telemetry", what}});
  failing = !ok;
}

}  // namespace telemetry
