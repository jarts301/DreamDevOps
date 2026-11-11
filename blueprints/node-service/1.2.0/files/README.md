# __APP_NAME__

A RESTful service in TypeScript, built on Fastify and Node.js 24.

## Run it

```bash
npm install
```

```bash
npm run dev
```

The service listens on <http://localhost:8080>. Try <http://localhost:8080/api/hello?name=Ada>.

To run it in a container, as the platform does:

```bash
docker compose up --build
```

## Checks

| Command | What it does |
|---|---|
| `npm test` | Runs the tests |
| `npm run lint` | Checks the code style |
| `npm run typecheck` | Checks the types |
| `npm run build` | Compiles to `dist/` |

The pipeline in `.forgejo/workflows/ci.yaml` runs all of them on every push and pull request.

## What the platform expects

| Item | Value |
|---|---|
| Port | `8080`, or the `PORT` variable |
| Liveness check | `GET /health/live` |
| Readiness check | `GET /health/ready` |
| Settings | Environment variables only, so one image runs in every environment |
| Telemetry | Metrics over OTLP, which the platform asks for and shows under **Monitoring**. See [Metrics](#metrics). |

## Metrics

When it runs on the platform, the service sends these metrics every 15 seconds, with OpenTelemetry's standard names, so any tool that reads OpenTelemetry shows them:

| Metric | What it measures | Shown as |
|---|---|---|
| `process.cpu.time` | CPU time the service has used | CPU |
| `process.memory.usage` | Memory it holds in RAM | Memory |
| `http.server.request.duration` | How long each request took, and its status | Requests, response time and server errors |

Health checks aren't counted, because they aren't traffic. `src/telemetry.ts` starts it all, and `src/metrics.ts` measures CPU and memory.

It sends only what it's told where to send, with the standard `OTEL_*` variables:

| Variable | Purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Where metrics go. The platform sets it. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Where traces go. Unset by default, so none are sent. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | One address for both, which gets `/v1/metrics` and `/v1/traces` added |
| `OTEL_METRIC_EXPORT_INTERVAL` | Milliseconds between sends, 15000 by default |
| `OTEL_RESOURCE_ATTRIBUTES` | Attributes every metric carries. The platform adds the environment's ID, which is how it knows where metrics come from. |

To add a metric of your own, get a meter with `metrics.getMeter()` from `@opentelemetry/api`, and it's sent with the others.

## Security updates

The `Dockerfile` pins its base images by digest, so every build starts from the same packages, and then applies the security fixes Alpine has released since, with `apk upgrade`. So when a scan finds a vulnerability that's fixed in a newer package, building again fixes it. To move to a newer base image, such as a new Node.js or nginx release, change its tag and digest in the `Dockerfile`.

## Branches

Work on `feature/*` branches and open a pull request into `develop`. A Tech Lead approves it. Releases and hotfixes are started from the DreamDevOps dashboard, which creates the branches and version tags. Nobody pushes to `develop` or `main` directly.

## Database changes

When you add a database, change its schema in two steps: first add the new structure while the old code still works with it, then remove the old structure in a later release. A rollback can't undo a destructive change, so each version must keep working with the schema of the one before.
