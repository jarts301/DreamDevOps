// Starts the service: reads the settings, starts telemetry, then serves the routes until the
// platform stops it.

#include <csignal>
#include <cstdlib>
#include <thread>

#include "app.hpp"
#include "config.hpp"
#include "logs.hpp"
#include "telemetry.hpp"

int main() {
  const auto env = process_env();
  Config config;
  try {
    config = load_config(env);
  } catch (const ConfigError& error) {
    logs::error(error.what());
    return EXIT_FAILURE;
  }
  // The platform stops the service with SIGTERM, and Ctrl+C sends SIGINT. They're blocked here,
  // before any thread starts, so every thread leaves them to the wait at the end.
  sigset_t stop_signals;
  sigemptyset(&stop_signals);
  sigaddset(&stop_signals, SIGTERM);
  sigaddset(&stop_signals, SIGINT);
  pthread_sigmask(SIG_BLOCK, &stop_signals, nullptr);

  telemetry::Telemetry telemetry(telemetry::settings(env), telemetry::resource(env));
  httplib::Server server;
  add_routes(server, config.cors_origins, telemetry);
  if (!server.bind_to_port(config.host, config.port)) {
    logs::error("The port can't be listened on", {{"host", config.host}, {"port", config.port}});
    return EXIT_FAILURE;
  }
  logs::info("Listening", {{"port", config.port}});
  std::thread serving([&server] { server.listen_after_bind(); });

  int signal = 0;
  sigwait(&stop_signals, &signal);
  logs::info("Stopping", {{"signal", signal == SIGTERM ? "SIGTERM" : "SIGINT"}});
  // Requests already started are answered first.
  server.stop();
  serving.join();
  telemetry.shutdown();
  return EXIT_SUCCESS;
}
