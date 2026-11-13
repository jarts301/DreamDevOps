# __APP_NAME__

A RESTful service in Rust, built on Axum, on Tokio.

## Run it

```bash
cargo build
```

```bash
cargo run
```

The service listens on <http://localhost:8080>. Try <http://localhost:8080/api/hello?name=Ada>, or <http://localhost:8080/api/ping>, which only answers and logs that it did.

To run it in a container, as the platform does:

```bash
docker compose up --build
```

## Checks

| Command | What it does |
|---|---|
| `cargo test` | Runs the tests |
| `cargo clippy --all-targets -- -D warnings` | Checks for mistakes and style, with Clippy |
| `cargo fmt --check` | Checks the formatting. `cargo fmt` fixes it. |

The pipeline in `.forgejo/workflows/ci.yaml` runs them on every push and pull request. To run them yourself, you need Rust 1.83 or newer, such as from <https://rustup.rs>, with Clippy and rustfmt.

## Layout

| File | Purpose |
|---|---|
| `src/main.rs` | Reads the settings, starts logs and telemetry, then serves the routes |
| `src/app.rs` | The routes, and what traces, measures and logs each request |
| `src/config.rs` | Reads the settings from environment variables |
| `src/telemetry.rs` | Starts OpenTelemetry, traces and measures requests, and measures CPU and memory |
| `src/logs.rs` | Writes JSON log lines, with their trace |
| `tests/app.rs` | The tests of the routes. The other files have tests of their own, at their end. |
| `Cargo.toml` | The dependencies, and the oldest Rust the service builds with |
| `Cargo.lock` | The exact version of each dependency, and its checksum |
| `rustfmt.toml` | The formatting settings |

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

Health checks aren't counted, because they aren't traffic. `src/telemetry.rs` measures each request, and CPU and memory, and sends them.

## Logs

The service logs each request, and what its routes say, as one line of JSON each, on standard output, where the platform reads them. Health checks aren't logged. Each line says which trace it was written in, in `trace_id` and `span_id`, so the platform shows lines beside their trace:

```json
{"time":"2026-11-10T12:00:00.000Z","level":"info","msg":"Ping received","logger":"service::app","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7","trace_flags":"01"}
```

Log with `tracing`'s macros, such as `tracing::info!(order = %order_id, "Order placed")`, and the line carries the request's trace. `src/logs.rs` writes the lines.

## Traces

When it runs on the platform, the service sends a trace of each request it answers, with its route, status and duration. A request that arrives with a W3C `traceparent` header, such as one another service or a web page sends, continues that caller's trace.

To carry the trace on to the services it calls, add it to the headers of each request, with `opentelemetry::global::get_text_map_propagator(|propagator| propagator.inject(&mut injector))`, while answering the request, so it's the request's trace. `opentelemetry_http::HeaderInjector` adds to the headers of the `http` crate, which clients such as `reqwest` use.

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

To add a metric of your own, get a meter with `opentelemetry::global::meter(SERVICE_NAME)`, with `SERVICE_NAME` from `src/telemetry.rs`, and it's sent with the others.

## Dependencies

Add a dependency with `cargo add`, such as `cargo add uuid`, and commit `Cargo.lock` with it. The pipeline and the image build only what `Cargo.lock` says, and fail if it's out of date.

## Rust version

The pipeline and the image use Alpine's Rust, which is 1.83 or newer, depending on the Alpine release in the base image. So `rust-version` in `Cargo.toml` is 1.83, and `.cargo/config.toml` tells Cargo to pick, for each dependency, the newest version that builds with it. To use newer versions, once the Rust that builds the service is newer, raise `rust-version` and run `cargo update`.

## Security updates

The `Dockerfile` pins its base image by digest, so every build starts from the same packages, and then applies the security fixes Alpine has released since, with `apk upgrade`. So when a scan finds a vulnerability that's fixed in a newer package, building again fixes it. The service is built with Alpine's own Rust, on the Alpine image the platform already pins, for Node.js, and runs on the same image, without Rust. To build with an official Rust image instead, change the first `FROM` line to its Alpine variant, pinned by digest, so the service still runs on Alpine, and remove the line that adds `cargo`.

## Branches

Work on `feature/*` branches and open a pull request into `develop`. A Tech Lead approves it. Releases and hotfixes are started from the DreamDevOps dashboard, which creates the branches and version tags. Nobody pushes to `develop` or `main` directly.

## Database changes

When you add a database, change its schema in two steps: first add the new structure while the old code still works with it, then remove the old structure in a later release. A rollback can't undo a destructive change, so each version must keep working with the schema of the one before.
