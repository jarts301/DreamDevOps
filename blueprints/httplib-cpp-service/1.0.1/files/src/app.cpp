#include "app.hpp"

#include <algorithm>
#include <chrono>
#include <optional>

#include "json.hpp"
#include "logs.hpp"
#include "trace_context.hpp"

namespace {

// Headers browsers may send across origins, including the trace a page started.
constexpr const char* CORS_HEADERS = "content-type, authorization, traceparent, tracestate";

// The request each worker thread is answering, from when it's routed until it's answered.
thread_local std::optional<telemetry::ObservedRequest> answering;

void reply(httplib::Response& response, int status, const json::Object& body) {
  response.status = status;
  response.set_content(body.str(), "application/json");
}

void problem(httplib::Response& response, int status, std::string_view error) {
  reply(response, status, json::Object().add("error", error));
}

// Counts characters, rather than bytes, as names are UTF-8.
std::size_t characters(std::string_view text) {
  return static_cast<std::size_t>(
      std::count_if(text.begin(), text.end(), [](char c) { return (static_cast<unsigned char>(c) & 0xc0) != 0x80; }));
}

}  // namespace

void add_routes(httplib::Server& server, const std::vector<std::string>& cors_origins,
                telemetry::Telemetry& telemetry) {
  server.set_pre_routing_handler([&telemetry, cors_origins](const httplib::Request& request,
                                                             httplib::Response& response) {
    // Each request is traced, within the trace a caller started, if it did, so its log lines
    // and spans are part of it.
    answering = telemetry.start_request(request.method, request.path, request.get_header_value("traceparent"));
    set_current_span(answering ? std::optional(answering->span) : std::nullopt);
    if (cors_origins.empty()) return httplib::Server::HandlerResponse::Unhandled;
    // Lets web pages at these origins call the service from browsers, and send the trace they
    // started, so a request from a page and its work here are one trace.
    const auto origin = request.get_header_value("origin");
    const auto allowed = std::find(cors_origins.begin(), cors_origins.end(), origin) != cors_origins.end();
    if (allowed) response.set_header("access-control-allow-origin", origin);
    response.set_header("vary", "Origin");
    // Browsers ask first, before a request with a header such as traceparent.
    if (request.method != "OPTIONS") return httplib::Server::HandlerResponse::Unhandled;
    response.status = allowed ? 204 : 403;
    if (allowed) {
      response.set_header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE");
      response.set_header("access-control-allow-headers", CORS_HEADERS);
      response.set_header("access-control-max-age", "600");
    }
    return httplib::Server::HandlerResponse::Handled;
  });

  server.set_post_routing_handler([&telemetry](const httplib::Request& request, httplib::Response& response) {
    if (answering) telemetry.finish_request(*answering, request.matched_route, response.status);
    answering.reset();
    set_current_span(std::nullopt);
  });

  // Errors without a body of their own, such as for a route the service doesn't have, get one in JSON.
  server.set_error_handler([](const httplib::Request&, httplib::Response& response) {
    if (!response.body.empty()) return httplib::Server::HandlerResponse::Unhandled;
    problem(response, response.status, response.status == 404 ? "Not found." : "The request can't be answered.");
    return httplib::Server::HandlerResponse::Handled;
  });

  // Anything a route throws is logged, within its request, and answered without its details.
  server.set_exception_handler(
      [](const httplib::Request&, httplib::Response& response, const std::exception_ptr& thrown) {
        std::string detail = "unknown";
        try {
          std::rethrow_exception(thrown);
        } catch (const std::exception& error) {
          detail = error.what();
        } catch (...) {
        }
        logs::error("Request failed", {{"error", detail}});
        problem(response, 500, "Something went wrong.");
      });

  // The platform checks these every few seconds to decide whether to restart the service or
  // send it traffic. They aren't logged or measured, so those show real traffic.
  const auto healthy = [](const httplib::Request&, httplib::Response& response) {
    reply(response, 200, json::Object().add("status", "ok"));
  };
  server.Get("/health/live", healthy);
  server.Get("/health/ready", healthy);

  // Answers without doing anything, to check the service can be reached, and logs that it was.
  server.Get("/api/ping", [](const httplib::Request&, httplib::Response& response) {
    logs::info("Ping received");
    reply(response, 200,
          json::Object().add("status", "ok").add("time", logs::timestamp(std::chrono::system_clock::now())));
  });

  server.Get("/api/hello", [](const httplib::Request& request, httplib::Response& response) {
    const auto given = request.get_param_value_count("name");
    const auto name = given == 0 ? std::string("world") : request.get_param_value("name");
    if (given > 1 || characters(name) < 1 || characters(name) > 100) {
      problem(response, 400, "name must be between 1 and 100 characters.");
      return;
    }
    logs::info("Greeting sent", {{"greeted", name}});
    reply(response, 200, json::Object().add("message", "Hello, " + name + "!"));
  });
}
