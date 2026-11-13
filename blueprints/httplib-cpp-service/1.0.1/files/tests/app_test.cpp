#include <doctest.h>

#include <thread>

#include "app.hpp"
#include "collector.hpp"
#include "logs.hpp"

namespace {

constexpr const char* TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
constexpr const char* CALLER_SPAN_ID = "00f067aa0ba902b7";

// The service, on a port of its own, with what it sends kept to look at.
class Running {
 public:
  explicit Running(std::vector<std::string> cors_origins = {})
      : telemetry_(sending_everything(), {}, collector.send()) {
    add_routes(server_, cors_origins, telemetry_);
    port_ = server_.bind_to_any_port("127.0.0.1");
    thread_ = std::thread([this] { server_.listen_after_bind(); });
    server_.wait_until_ready();
  }

  ~Running() {
    server_.stop();
    thread_.join();
  }

  Running(const Running&) = delete;
  Running& operator=(const Running&) = delete;

  httplib::Result get(const std::string& path, const httplib::Headers& headers = {}) {
    return client().Get(path, headers);
  }

  httplib::Result options(const std::string& path, const httplib::Headers& headers) {
    return client().Options(path, headers);
  }

  // Sends what's waiting, and gives what was sent to a path, such as /v1/traces.
  std::string sent_to(const std::string& path) {
    telemetry_.flush();
    return collector.sent_to(path);
  }

  Collector collector;

 private:
  httplib::Client client() {
    httplib::Client client("127.0.0.1", port_);
    return client;
  }

  telemetry::Telemetry telemetry_;
  httplib::Server server_;
  int port_ = 0;
  std::thread thread_;
};

}  // namespace

TEST_CASE("answers the platform's health checks, without logging, tracing or measuring them") {
  Running service;
  const logs::Capture logs;
  for (const auto* path : {"/health/live", "/health/ready"}) {
    const auto response = service.get(path);
    REQUIRE(response);
    CHECK(response->status == 200);
    CHECK(response->body == R"({"status":"ok"})");
  }
  CHECK(logs.lines().empty());
  CHECK(service.sent_to("/v1/traces").empty());
  CHECK_FALSE(contains(service.sent_to("/v1/metrics"), "http.server.request.duration"));
}

TEST_CASE("answers a ping, and logs it") {
  Running service;
  const logs::Capture logs;
  const auto response = service.get("/api/ping");
  REQUIRE(response);
  CHECK(response->status == 200);
  CHECK(response->get_header_value("content-type") == "application/json");
  CHECK(response->body.starts_with(R"({"status":"ok","time":")"));
  const auto lines = logs.lines();
  REQUIRE(lines.size() == 2);
  CHECK(contains(lines[0], R"("msg":"Ping received")"));
  CHECK(contains(lines[1], R"("msg":"request completed")"));
  CHECK(contains(lines[1], R"("method":"GET","path":"/api/ping","status":200)"));
}

TEST_CASE("greets by name, or the world") {
  Running service;
  const logs::Capture logs;
  CHECK(service.get("/api/hello?name=Ada")->body == R"({"message":"Hello, Ada!"})");
  CHECK(service.get("/api/hello?name=Jos%C3%A9")->body == R"({"message":"Hello, José!"})");
  CHECK(service.get("/api/hello")->body == R"({"message":"Hello, world!"})");
  CHECK(contains(logs.lines().at(0), R"("greeted":"Ada")"));
}

TEST_CASE("refuses a name that's empty, too long, or given twice") {
  Running service;
  for (const auto& path :
       {std::string("/api/hello?name="), "/api/hello?name=" + std::string(101, 'x'), std::string("/api/hello?name=Ada&name=Alan")}) {
    CAPTURE(path);
    const auto response = service.get(path);
    REQUIRE(response);
    CHECK(response->status == 400);
    CHECK(response->body == R"({"error":"name must be between 1 and 100 characters."})");
  }
  // 100 characters, of two bytes each.
  std::string longest = "/api/hello?name=";
  for (int i = 0; i < 100; ++i) longest += "%C3%A9";
  CHECK(service.get(longest)->status == 200);
}

TEST_CASE("answers 404 for a route it doesn't have") {
  Running service;
  const auto response = service.get("/api/nothing");
  REQUIRE(response);
  CHECK(response->status == 404);
  CHECK(response->body == R"({"error":"Not found."})");
}

TEST_CASE("continues the trace a caller started") {
  Running service;
  const logs::Capture logs;
  service.get("/api/ping", {{"traceparent", std::string("00-") + TRACE_ID + "-" + CALLER_SPAN_ID + "-01"}});
  const auto traces = service.sent_to("/v1/traces");
  CHECK(contains(traces, std::string(R"("traceId":")") + TRACE_ID));
  CHECK(contains(traces, std::string(R"("parentSpanId":")") + CALLER_SPAN_ID + R"(","name":"GET /api/ping")"));
  for (const auto& line : logs.lines()) CHECK(contains(line, std::string(R"("trace_id":")") + TRACE_ID));
}

TEST_CASE("measures each request, with its route and status") {
  Running service;
  const logs::Capture logs;
  service.get("/api/hello?name=");
  const auto metrics = service.sent_to("/v1/metrics");
  CHECK(contains(metrics, "http.server.request.duration"));
  CHECK(contains(metrics, R"({"key":"http.response.status_code","value":{"intValue":"400"}})"));
  CHECK(contains(metrics, R"({"key":"http.route","value":{"stringValue":"/api/hello"}})"));
}

TEST_CASE("lets the web pages it lists call it, and send their trace") {
  Running service({"https://shop.example.com"});
  const logs::Capture logs;
  const auto preflight = service.options("/api/ping", {{"origin", "https://shop.example.com"},
                                                       {"access-control-request-method", "GET"},
                                                       {"access-control-request-headers", "traceparent"}});
  REQUIRE(preflight);
  CHECK(preflight->status == 204);
  CHECK(preflight->get_header_value("access-control-allow-origin") == "https://shop.example.com");
  CHECK(contains(preflight->get_header_value("access-control-allow-headers"), "traceparent"));
  const auto response = service.get("/api/ping", {{"origin", "https://shop.example.com"}});
  CHECK(response->get_header_value("access-control-allow-origin") == "https://shop.example.com");
}

TEST_CASE("lets no other web page call it") {
  const logs::Capture logs;
  {
    Running service({"https://shop.example.com"});
    const auto response = service.get("/api/ping", {{"origin", "https://evil.example.com"}});
    CHECK(response->status == 200);
    CHECK_FALSE(response->has_header("access-control-allow-origin"));
    const auto preflight = service.options("/api/ping", {{"origin", "https://evil.example.com"},
                                                         {"access-control-request-method", "GET"}});
    CHECK(preflight->status == 403);
  }
  Running service;
  const auto response = service.get("/api/ping", {{"origin", "https://shop.example.com"}});
  CHECK_FALSE(response->has_header("access-control-allow-origin"));
}
