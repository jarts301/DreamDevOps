# __APP_NAME__

A RESTful service in JavaScript, built on Fastify 5 and Node.js 24.

## Run it

```bash
npm install
```

```bash
npm run dev
```

The service listens on <http://localhost:8080>. Try <http://localhost:8080/api/hello?name=Ada>, or <http://localhost:8080/api/ping>, which only answers and logs that it did.

To run it in a container, as the platform does:

```bash
docker compose up --build
```

## Checks

| Command | What it does |
|---|---|
| `npm test` | Runs the tests, with Vitest |
| `npm run lint` | Checks the code style, with ESLint |
| `npm run typecheck` | Checks the types in JSDoc comments, with TypeScript |

The pipeline in `.forgejo/workflows/ci.yaml` runs them on every push and pull request.

## Layout

| File | Purpose |
|---|---|
| `src/main.js` | Reads the settings, then starts the service |
| `src/app.js` | The routes |
| `src/config.js` | Reads the settings from environment variables |
| `src/telemetry.js` | Starts OpenTelemetry, before the service loads |
| `src/metrics.js` | Measures CPU and memory |
| `src/logging.js` | Adds the trace to every log line |
| `test/` | The tests |

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

Health checks aren't counted, because they aren't traffic. `src/telemetry.js` starts it all, and `src/metrics.js` measures CPU and memory.

## Logs

The service logs each request, and what its routes say, as one line of JSON each, on standard output, where the platform reads them. Health checks aren't logged. Each line says which trace it was written in, in `trace_id` and `span_id`, so the platform shows lines beside their trace:

```json
{"level":30,"time":1794312000000,"reqId":"req-1","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7","msg":"Ping received"}
```

Log from a route with `request.log`, such as `request.log.info({ orderId }, 'Order placed')`, and the line carries the request and its trace. `src/logging.js` adds the trace.

## Traces

When it runs on the platform, the service sends a trace of each request it answers, with its route, status and duration. A request that arrives with a W3C `traceparent` header, such as one another service or a web page sends, continues that caller's trace.

Requests the service makes with `fetch` are traced too, and carry the trace on, so the services it calls continue it. A request through several applications is then one trace, which the platform shows across them.

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

To add a metric of your own, get a meter with `metrics.getMeter()` from `@opentelemetry/api`, and it's sent with the others.

## Security updates

The `Dockerfile` pins its base images by digest, so every build starts from the same packages, and then applies the security fixes Alpine has released since, with `apk upgrade`. So when a scan finds a vulnerability that's fixed in a newer package, building again fixes it. To move to a newer base image, such as a new Node.js release, change its tag and digest in the `Dockerfile`. The image runs the service with Node.js alone: npm, npx, Corepack and Yarn, which come with the base image, are removed, as scanners report the packages they bring. So is the project's `package.json`, which is named after the application and could match a published package's name.

## Branches

Work on `feature/*` branches and open a pull request into `develop`. A Tech Lead approves it. Releases and hotfixes are started from the DreamDevOps dashboard, which creates the branches and version tags. Nobody pushes to `develop` or `main` directly.

## Database changes

When you add a database, change its schema in two steps: first add the new structure while the old code still works with it, then remove the old structure in a later release. A rollback can't undo a destructive change, so each version must keep working with the schema of the one before.
