// The service's routes, on cpp-httplib.
#pragma once

#include <httplib.h>

#include <string>
#include <vector>

#include "telemetry.hpp"

// Adds the service's routes to a server, and traces, measures and logs each request, so
// tests can serve them on a port of their own. Web pages at cors_origins may call it.
void add_routes(httplib::Server& server, const std::vector<std::string>& cors_origins,
                telemetry::Telemetry& telemetry);
