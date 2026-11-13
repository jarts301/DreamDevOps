# __APP_NAME__

A RESTful service in C++20, built on [cpp-httplib](https://github.com/yhirose/cpp-httplib).

## Run it

```bash
cmake -S . -B build
```

```bash
cmake --build build --parallel
```

```bash
build/service
```

The service listens on <http://localhost:8080>. Try <http://localhost:8080/api/hello?name=Ada>, or <http://localhost:8080/api/ping>, which only answers and logs that it did.

To run it in a container, as the platform does:

```bash
docker compose up --build
```

## Checks

| Command | What it does |
|---|---|
| `ctest --test-dir build --output-on-failure` | Runs the tests, with doctest |
| `cmake -S . -B build -DWARNINGS_AS_ERRORS=ON` | Makes every compiler warning an error, as the pipeline does, for the next build |
| `sha256sum -c third_party/SHA256SUMS` | Checks the libraries in `third_party` are the ones locked |

The pipeline in `.forgejo/workflows/ci.yaml` runs them on every push and pull request. To run them yourself, you need a C++20 compiler, such as GCC 13 or newer, and CMake 3.20 or newer.

## Layout

| File | Purpose |
|---|---|
| `src/main.cpp` | Reads the settings, starts telemetry, then serves the routes until the platform stops the service |
| `src/app.cpp` | The routes, and what traces, measures and logs each request |
| `src/config.cpp` | Reads the settings from environment variables |
| `src/telemetry.cpp` | Traces and measures requests, measures CPU and memory, and sends them |
| `src/trace_context.cpp` | Reads and makes W3C trace IDs, and knows which span the code runs in |
| `src/logs.cpp` | Writes JSON log lines, with their trace |
| `src/json.cpp` | Writes JSON |
| `tests/` | The tests, with doctest |
| `third_party/` | cpp-httplib and doctest, each a single header, and their checksums |
| `CMakeLists.txt` | How the service and its tests are built |

## What the platform expects

| Item | Value |
|---|---|
| Port | `8080`, or the `PORT` variable |
| Liveness check | `GET /health/live` |
| Readiness check | `GET /health/ready` |
| Settings | Environment variables only, so one image runs in every environment |
| Logs | JSON lines on standard output, which the platform shows under **Monitoring**. See [Logs](#logs). |
| Telemetry | Metrics and traces over OTLP, which the platform asks for and shows under **Monitoring**. See [Metrics](#metrics) and [Traces](#traces). |

## Routes

| Route | Answers |
|---|---|
| `GET /health/live`, `GET /health/ready` | `{"status":"ok"}`, for the platform's health checks |
| `GET /api/ping` | `{"status":"ok","time":"…"}`, and logs `Ping received` |
| `GET /api/hello?name=Ada` | `{"message":"Hello, Ada!"}`. A name must be 1 to 100 characters, or the answer is `400`. |

## Metrics

When it runs on the platform, the service sends these metrics every 15 seconds, with OpenTelemetry's standard names, so any tool that reads OpenTelemetry shows them:

| Metric | What it measures | Shown as |
|---|---|---|
| `process.cpu.time` | CPU time the service has used | CPU |
| `process.memory.usage` | Memory it holds in RAM | Memory |
| `http.server.request.duration` | How long each request took, and its status | Requests, response time and server errors |

Health checks aren't counted, because they aren't traffic. `src/telemetry.cpp` measures each request, and CPU and memory, and sends them as OTLP, in JSON.

## Logs

The service logs each request, and what its routes say, as one line of JSON each, on standard output, where the platform reads them. Health checks aren't logged. Each line says which trace it was written in, in `trace_id` and `span_id`, so the platform shows lines beside their trace:

```json
{"time":"2026-11-10T12:00:00.000Z","level":"info","msg":"Ping received","logger":"service","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7","trace_flags":"01"}
```

Log with `logs::info("Order placed", {{"order", order_id}})`, or `logs::warn` and `logs::error`, from `src/logs.hpp`, and the line carries the request's trace. cpp-httplib answers each request on one thread, and the trace is kept for that thread, so work the service hands to another thread doesn't carry it.

## Traces

When it runs on the platform, the service sends a trace of each request it answers, with its route, status and duration. A request that arrives with a W3C `traceparent` header, such as one another service or a web page sends, continues that caller's trace.

To carry the trace on to the services it calls, send each request a W3C `traceparent` header, of `"00-" + span->trace_id_hex() + "-" + span->span_id_hex() + "-" + span->flags_hex()`, with `span` from `current_span()`, in `src/trace_context.hpp`.

## Calls from web pages

Browsers let a page call the service only if the service says it may. List the origins of the pages that may, separated by commas, in `CORS_ORIGINS`, such as `https://shop.example.com`. They may send `traceparent`, so a page's request and the work it causes here are one trace. By default, no other page may call it.

## Settings for telemetry

It sends only what it's told where to send, with the standard `OTEL_*` variables:

| Variable | Purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Where metrics go. The platform sets it. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Where traces go. The platform sets it. |
| `OTEL_SERVICE_NAME` | The name traces and metrics come under. The platform sets it to the application's short name. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | One address for both, which gets `/v1/metrics` and `/v1/traces` added |
| `OTEL_METRIC_EXPORT_INTERVAL` | Milliseconds between sends, 15000 by default |
| `OTEL_RESOURCE_ATTRIBUTES` | Attributes every metric and trace carries. The platform adds the environment's ID, which is how it knows where they come from. |

To add a metric of your own, add it to what `Telemetry::send_metrics` in `src/telemetry.cpp` sends, and it's sent with the others.

## Dependencies

The service uses two libraries, each a single header, kept in `third_party`: cpp-httplib, for HTTP, and doctest, for the tests. `third_party/README.md` says where each came from, and `third_party/SHA256SUMS` holds their checksums, which the pipeline checks, as it would a lockfile. To update one, replace its header and its checksum.

Telemetry is sent over plain HTTP, as the platform receives it. To send it over HTTPS, build cpp-httplib with OpenSSL, as its README explains.

## Security updates

The `Dockerfile` pins its base image by digest, so every build starts from the same packages, and then applies the security fixes Alpine has released since, with `apk upgrade`. So when a scan finds a vulnerability that's fixed in a newer package, building again fixes it. The service is built with Alpine's own GCC, on the Alpine image the platform already pins, for Node.js, and runs on the same image, without the compiler. Both stages use the same image, so the service runs with the C++ libraries it was built with. To move to a newer image, change both `FROM` lines, pinned by digest. Node.js, npm and Yarn, which come with the base image, are removed from the image, as the service uses none of them and scanners report the packages they bring.

## Branches

Work on `feature/*` branches and open a pull request into `develop`. A Tech Lead approves it. Releases and hotfixes are started from the DreamDevOps dashboard, which creates the branches and version tags. Nobody pushes to `develop` or `main` directly.

## Database changes

When you add a database, change its schema in two steps: first add the new structure while the old code still works with it, then remove the old structure in a later release. A rollback can't undo a destructive change, so each version must keep working with the schema of the one before.
