#include <doctest.h>

#include "collector.hpp"
#include "logs.hpp"
#include "telemetry.hpp"

TEST_CASE("sends nothing unless told where") {
  const auto settings = telemetry::settings({});
  CHECK(settings.metrics_endpoint.empty());
  CHECK(settings.traces_endpoint.empty());
  CHECK(settings.export_interval == std::chrono::seconds(15));
}

TEST_CASE("sends what it's told where to send") {
  auto settings = telemetry::settings({{"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "http://collector:4318/v1/metrics"},
                                       {"OTEL_METRIC_EXPORT_INTERVAL", "1000"}});
  CHECK(settings.metrics_endpoint == "http://collector:4318/v1/metrics");
  CHECK(settings.traces_endpoint.empty());
  CHECK(settings.export_interval == std::chrono::seconds(1));
  settings = telemetry::settings({{"OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318/"}});
  CHECK(settings.metrics_endpoint == "http://collector:4318/v1/metrics");
  CHECK(settings.traces_endpoint == "http://collector:4318/v1/traces");
}

TEST_CASE("keeps the default interval when the one given isn't valid") {
  for (const auto* interval : {"0", "soon", "-5", "99999999999999"}) {
    CAPTURE(interval);
    CHECK(telemetry::settings({{"OTEL_METRIC_EXPORT_INTERVAL", interval}}).export_interval ==
          std::chrono::seconds(15));
  }
}

TEST_CASE("names the service, and adds the attributes the platform gives") {
  using telemetry::Attribute;
  CHECK(telemetry::resource({}) == std::vector<Attribute>{{"service.name", std::string(telemetry::SERVICE_NAME)}});
  const auto resource = telemetry::resource(
      {{"OTEL_SERVICE_NAME", "shop"},
       {"OTEL_RESOURCE_ATTRIBUTES", "team=web%20shop, service.name=other,dreamdevops.environment.id=42,broken"}});
  CHECK(resource == std::vector<Attribute>{{"service.name", "shop"},
                                           {"team", "web shop"},
                                           {"dreamdevops.environment.id", "42"}});
}

TEST_CASE("measures the process") {
  const auto usage = telemetry::process_usage();
  CHECK(usage.user_cpu >= 0);
  CHECK(usage.system_cpu >= 0);
#ifdef __linux__
  CHECK(usage.memory > 0);
#endif
}

TEST_CASE("knows health checks") {
  CHECK(telemetry::is_health_check("/health/live"));
  CHECK(telemetry::is_health_check("/health/ready"));
  CHECK_FALSE(telemetry::is_health_check("/api/ping"));
  CHECK_FALSE(telemetry::is_health_check("/healthy"));
}

TEST_CASE("sends the service's CPU time and memory, with its attributes, over OTLP") {
  Collector collector;
  telemetry::Telemetry telemetry(sending_everything(), {{"dreamdevops.environment.id", "42"}}, collector.send());
  telemetry.flush();
  const auto metrics = collector.sent_to("/v1/metrics");
  CHECK(contains(metrics, R"({"key":"dreamdevops.environment.id","value":{"stringValue":"42"}})"));
  CHECK(contains(metrics, R"("name":"process.cpu.time","unit":"s")"));
  CHECK(contains(metrics, R"({"key":"cpu.mode","value":{"stringValue":"user"}})"));
  CHECK(contains(metrics, R"("name":"process.memory.usage","unit":"By")"));
  CHECK_FALSE(contains(metrics, "http.server.request.duration"));
  CHECK(collector.sent_to("/v1/traces").empty());
}

TEST_CASE("traces and measures a request, continuing its caller's trace") {
  Collector collector;
  telemetry::Telemetry telemetry(sending_everything(), {}, collector.send());
  const logs::Capture logs;
  const auto request =
      telemetry.start_request("GET", "/api/hello", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  REQUIRE(request);
  telemetry.finish_request(*request, "/api/hello", 200);
  telemetry.flush();
  const auto traces = collector.sent_to("/v1/traces");
  CHECK(contains(traces, R"("traceId":"4bf92f3577b34da6a3ce929d0e0e4736")"));
  CHECK(contains(traces, R"("parentSpanId":"00f067aa0ba902b7","name":"GET /api/hello","kind":2)"));
  CHECK(contains(traces, R"({"key":"http.response.status_code","value":{"intValue":"200"}})"));
  const auto metrics = collector.sent_to("/v1/metrics");
  CHECK(contains(metrics, R"("name":"http.server.request.duration","unit":"s")"));
  CHECK(contains(metrics, R"({"key":"http.route","value":{"stringValue":"/api/hello"}})"));
  CHECK(contains(metrics, R"("count":"1")"));
  CHECK(contains(logs.lines().at(0), R"("msg":"request completed")"));
}

TEST_CASE("marks the span of a request that failed") {
  Collector collector;
  telemetry::Telemetry telemetry(sending_everything(), {}, collector.send());
  const logs::Capture logs;
  telemetry.finish_request(*telemetry.start_request("GET", "/api/ping", ""), "/api/ping", 500);
  telemetry.flush();
  CHECK(contains(collector.sent_to("/v1/traces"), R"("status":{"code":2})"));
}

TEST_CASE("leaves health checks out") {
  Collector collector;
  telemetry::Telemetry telemetry(sending_everything(), {}, collector.send());
  CHECK_FALSE(telemetry.start_request("GET", "/health/live", ""));
}

TEST_CASE("sends what's waiting when it shuts down") {
  Collector collector;
  const logs::Capture logs;
  {
    telemetry::Telemetry telemetry(sending_everything(), {}, collector.send());
    telemetry.finish_request(*telemetry.start_request("GET", "/api/ping", ""), "/api/ping", 200);
  }
  CHECK(contains(collector.sent_to("/v1/traces"), R"("name":"GET /api/ping")"));
}

TEST_CASE("says when telemetry can't be sent, once, until it can again") {
  bool works = false;
  const logs::Capture logs;
  telemetry::Telemetry telemetry(sending_everything(), {}, [&works](const std::string&, const std::string&,
                                                                    std::string& problem) {
    problem = "Connection refused";
    return works;
  });
  telemetry.flush();
  telemetry.flush();
  works = true;
  telemetry.flush();
  const auto lines = logs.lines();
  REQUIRE(lines.size() == 2);
  CHECK(contains(lines[0], R"("level":"warn","msg":"Telemetry can't be sent")"));
  CHECK(contains(lines[0], R"("telemetry":"metrics","error":"Connection refused")"));
  CHECK(contains(lines[1], R"("msg":"Telemetry is sent again","logger":"service","telemetry":"metrics")"));
}

TEST_CASE("refuses addresses it can't send to") {
  std::string problem;
  CHECK_FALSE(telemetry::post_json("collector:4318", "{}", problem));
  CHECK(contains(problem, "isn't a URL"));
}
