# __APP_NAME__

A RESTful service in Python, built on Flask 3, served by Waitress.

## Run it

```bash
python3 -m venv .venv
```

```bash
.venv/bin/pip install --require-hashes -r requirements-dev.txt
```

```bash
.venv/bin/python -m service
```

The service listens on <http://localhost:8080>. Try <http://localhost:8080/api/hello?name=Ada>, or <http://localhost:8080/api/ping>, which only answers and logs that it did.

To run it in a container, as the platform does:

```bash
docker compose up --build
```

## Checks

| Command | What it does |
|---|---|
| `.venv/bin/pytest` | Runs the tests |
| `.venv/bin/ruff check .` | Checks for mistakes and style, with Ruff |
| `.venv/bin/ruff format --check .` | Checks the formatting. `ruff format .` fixes it. |
| `.venv/bin/mypy` | Checks the types, strictly |

The pipeline in `.forgejo/workflows/ci.yaml` runs them on every push and pull request. On Windows, the commands are in `.venv\\Scripts\\` instead of `.venv/bin/`.

## Layout

| File | Purpose |
|---|---|
| `service/__main__.py` | Reads the settings, starts telemetry, then serves the app with Waitress |
| `service/app.py` | The routes |
| `service/config.py` | Reads the settings from environment variables |
| `service/telemetry.py` | Starts OpenTelemetry, and measures CPU and memory |
| `service/logs.py` | Writes JSON log lines, with their trace |
| `tests/` | The tests, with pytest |
| `pyproject.toml` | The dependencies, and the settings of Ruff, mypy and pytest |
| `requirements.txt` | The exact packages the service runs with, and their hashes |
| `requirements-dev.txt` | The same, with what the checks need |

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

Health checks aren't counted, because they aren't traffic. OpenTelemetry's instrumentation for the framework measures each request, and `service/telemetry.py` starts it all, and measures CPU and memory.

## Logs

The service logs each request, and what its routes say, as one line of JSON each, on standard output, where the platform reads them. Health checks aren't logged. Each line says which trace it was written in, in `trace_id` and `span_id`, so the platform shows lines beside their trace:

```json
{"time":"2026-11-10T12:00:00.000+00:00","level":"info","msg":"Ping received","logger":"service","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7","trace_flags":"01"}
```

Log with the standard `logging` module, such as `logger.info("Order placed", extra={"order": order_id})`, and the line carries the request's trace. `service/logs.py` writes the lines. Waitress's own lines are JSON too. Waitress serves with threads in one process, rather than forking workers, so OpenTelemetry, which sends from a thread of its own, keeps sending.

## Traces

When it runs on the platform, the service sends a trace of each request it answers, with its route, status and duration. A request that arrives with a W3C `traceparent` header, such as one another service or a web page sends, continues that caller's trace.

To trace the requests the service makes, and carry the trace on to the services it calls, add OpenTelemetry's instrumentation for the HTTP client you use, such as `opentelemetry-instrumentation-httpx`, and call its `instrument()` in `service/__main__.py`.

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

To add a metric of your own, get a meter with `metrics.get_meter()` from `opentelemetry`, and it's sent with the others.

## Dependencies

Add a dependency to `pyproject.toml`, then lock it, with its hash, for every platform:

```bash
uv pip compile pyproject.toml --universal --generate-hashes --python-version 3.12 --no-annotate -o requirements.txt
```

```bash
uv pip compile pyproject.toml --group dev --universal --generate-hashes --python-version 3.12 --no-annotate -o requirements-dev.txt
```

Installs check every package against its hash, so nothing but what was locked is installed.

## Security updates

The `Dockerfile` pins its base image by digest, so every build starts from the same packages, and then applies the security fixes Alpine has released since, with `apk upgrade`, and adds Python from Alpine's packages. So when a scan finds a vulnerability that's fixed in a newer package, building again fixes it. The base is the Alpine image the platform already pins, for Node.js. To use an official Python image instead, change both `FROM` lines to it, pinned by digest, remove the lines that add `python3`, and add a user for the service to run as, as that image has no `node` user. Node.js, npm and Yarn, which come with the base image, are removed from the image, as the service uses none of them and scanners report the packages they bring.

## Branches

Work on `feature/*` branches and open a pull request into `develop`. A Tech Lead approves it. Releases and hotfixes are started from the DreamDevOps dashboard, which creates the branches and version tags. Nobody pushes to `develop` or `main` directly.

## Database changes

When you add a database, change its schema in two steps: first add the new structure while the old code still works with it, then remove the old structure in a later release. A rollback can't undo a destructive change, so each version must keep working with the schema of the one before.
