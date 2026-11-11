# Monitoring

Shows how the versions that run in each company's environments are doing: their CPU, memory, requests, response times and server errors, what they write to their logs, and the traces of the requests they answer. The dashboard shows them under **Monitoring**.

- **Metrics:** applications send them with OpenTelemetry to Prometheus.
- **Traces:** applications send them with OpenTelemetry to Jaeger.
- **Logs:** applications just write to their output, and the platform reads it from their containers.

The platform tells each container where to send metrics and traces, and which environment it is. This context reads everything back, only ever for the current company's environments.

## Contents

- [How metrics and traces get here](#how-metrics-and-traces-get-here)
- [Metrics](#metrics)
- [Logs](#logs)
- [Traces](#traces)
- [Routes](#routes)
- [Data separation](#data-separation)
- [Settings](#settings)
- [Not included yet](#not-included-yet)

## How metrics and traces get here

1. **Deploying:** when a container starts, [Environments](../environments/README.md#variables-and-secrets) gives it the standard OpenTelemetry settings:
   - `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, where to send them
   - `OTEL_SERVICE_NAME`, the application's short name
   - `OTEL_RESOURCE_ATTRIBUTES` with `dreamdevops.environment.id`, the environment's ID
2. **Sending:** the application sends metrics every 15 seconds, and each trace as its requests finish, over OTLP.
   - Applications started from the [blueprints](../../../../blueprints/README.md) from version 1.3.0 send both with no changes. From 1.2.0, they send metrics, and services send traces too.
   - Any other application that uses OpenTelemetry does the same, as long as it reads the standard settings.
3. **Keeping:**
   - Prometheus keeps the metrics, and turns the environment's attribute into the label `dreamdevops_environment_id`, as [its settings](../../../../infra/local/prometheus/prometheus.yml) ask.
   - Jaeger keeps the traces, with the attribute on every span.
4. **Reading:** this context asks [Environments](../environments/README.md) what runs where, through `RunningEnvironments`, and asks Prometheus and Jaeger about those environments only.

Versions deployed before the platform kept metrics or traces send none until they're deployed again, because containers get their settings as they start.

## Metrics

Each is worked out from OpenTelemetry's standard metrics, by their names:

| Metric | From | Worked out as |
|---|---|---|
| CPU | `process.cpu.time` | The share of one CPU core used, over the last two minutes |
| Memory | `process.memory.usage` | The latest value |
| Requests | `http.server.request.duration` | Requests answered each second, over the last two minutes |
| Response time | `http.server.request.duration` | The time within which 95% of requests were answered |
| Server errors | `http.server.request.duration` | The share of requests answered with a 5xx status |

An application that sends none of one shows **No data** for it, rather than zero. The Angular frontend blueprint sends CPU and memory only, because nginx only serves files.

The definitions are in `domain/metrics.ts`, and their PromQL in `infrastructure/prometheus-metrics-store.ts`.

## Logs

Every line a version writes to its standard output or error output is a log line. Applications need nothing else: Environments reads the lines from the container, through `EnvironmentLogs`, on the host it runs on.

- **Reading:** the page shows the latest 500 lines within the chosen range, newest first, with a filter.
- **JSON lines:** lines in JSON show their level and message, and the trace they were written in, which opens from the line. Fastify's and nginx's lines in the blueprints are JSON.
  - **Level:** `level` or `severity`, named or as pino's numbers
  - **Message:** `msg` or `message`, with the request a framework logged it about
  - **Trace:** `trace_id` and `span_id`, or a W3C `traceparent`
- **Other lines:** shown as they are, and lines on the error output are marked as such.
- **Keeping:** the platform keeps no copy. Lines come from the container that runs now, so a new deployment starts them afresh, and stopping the environment removes them.

`domain/logs.ts` reads each line.

## Traces

A trace follows one request through every application that works on it, as spans. Each span is one application's part, such as answering the request, or calling another application. Services started from the Node.js blueprint continue the trace a caller sends, in its `traceparent` header, and pass it on when they call others, so a request through several applications is one trace. The Angular blueprint starts a trace for each call to its API.

- **Listing:** an environment's traces are found in Jaeger by its service name, the application's short name, and then only this environment's own spans count. An application that sends another `OTEL_SERVICE_NAME` isn't found.
- **Showing:** a trace shows as a timeline, each span under the one it's part of, with its application, environment, duration, and whether it failed.
- **Other companies:** only the spans the company's own environments sent are shown. Spans from elsewhere are counted, not shown.
- **Keeping:** locally, Jaeger keeps traces in memory, so restarting it clears them.

`domain/traces.ts` sums traces up, and `infrastructure/jaeger-trace-store.ts` reads Jaeger's query API.

## Routes

All routes start with `/api/v1`, need `dashboards:view`, which every company role has, and need the `monitoring` feature, which every edition includes. They change nothing.

| Route | Purpose |
|---|---|
| `GET /company/monitoring/environments` | Every active environment a version runs in, by application, with its latest metrics. `enabled` says whether the server keeps metrics, and `problem` why they couldn't be read, if they couldn't. The environments are listed either way. |
| `GET /company/monitoring/environments/:id?range=1h` | One environment's metrics over the last `15m`, `1h` (default), `6h` or `24h`, about 60 points each, for charts |
| `GET /company/monitoring/environments/:id/logs?range=1h` | The latest 500 lines its version wrote within the range, oldest first. `running` says whether a version runs in it. |
| `GET /company/monitoring/environments/:id/traces?range=1h` | The latest 20 traces it took part in within the range, newest first. `enabled` says whether the server keeps traces. |
| `GET /company/monitoring/traces/:traceId` | One trace, by its 32-digit ID, with the company's own spans |

Errors use the API's `application/problem+json` format: `400` for another range or a trace ID that isn't one, `404` for an unknown environment or another company's, or a trace with none of the company's spans, and `503` when the server keeps no metrics or traces, or Prometheus, Jaeger or the host can't answer.

## Data separation

- **Asking:** the list of environments comes from Environments, in the current company, under row-level security. Queries to Prometheus name those environments' IDs and nothing else, and logs are read only from those environments' containers.
- **Traces:** traces can cross companies, so every trace, and every span, is checked. A span shows only when its environment belongs to the company, and IDs are checked before they go into a query.
- **Sending:** metrics and traces are labelled by what the application sends. The platform adds the environment's attribute last, after any of the environment's own, so it counts. But an application's own code could still send them under another environment's ID, if it knew it, and they'd show as that environment's. That's one more reason [This machine](../environments/README.md#this-machine) is for trying things out and small teams.
- **The tools' own pages:** Prometheus's page, at <http://localhost:9090>, and Jaeger's, at <http://localhost:16686>, show every company's data, so only whoever runs the machine should reach them. Locally they accept connections only from this machine, but [applications on This machine can reach them](../environments/README.md#this-machine) through `host.docker.internal`, as they must to send.
- **Logs can hold anything:** an application might log a secret. Only members with `dashboards:view`, of the company the application belongs to, can read its logs.

## Settings

| Setting | Purpose |
|---|---|
| `PROMETHEUS_URL` | Where the API reads metrics, such as `http://localhost:9090`. Without it, the dashboard says metrics aren't set up, and lists what runs anyway. |
| `APP_METRICS_OTLP_ENDPOINT` | Where containers send metrics, as they reach it, such as `http://host.docker.internal:9090/api/v1/otlp/v1/metrics`. Without it, containers aren't told to send any. |
| `JAEGER_URL` | Where the API reads traces, such as `http://localhost:16686`. Without it, the dashboard says traces aren't set up. |
| `APP_TRACES_OTLP_ENDPOINT` | Where containers send traces, as they reach it, such as `http://host.docker.internal:4318/v1/traces`. Without it, containers aren't told to send any. |

`npm run start:api` sets all four for the local Prometheus and Jaeger. Logs need no setting. Metrics are kept for `METRICS_RETENTION`, 15 days by default.

## Not included yet

- **Alerts:** the `monitoring` feature includes them, but nothing watches the metrics yet.
- **Kept logs:** logs come from the running container only, so they end with it. Searching older logs needs a log store.
- **Traces from browsers:** the Angular blueprint starts each trace, but doesn't send the browser's own span, so a trace starts at the API, under a parent span nobody reported.
- **Checked senders:** Prometheus and Jaeger accept data from anything that reaches them, labelled as the sender says. A collector that checks each environment's own token would stop one environment sending as another.
- **Resource limits:** charts don't show the limits containers run with, such as 512 MB of memory on This machine.
- **Other providers:** only This machine deploys, so only it is monitored. Other providers will need their own way to reach the stores and read logs.
- **Older blueprints:** applications started from blueprint versions before 1.2.0 send no metrics or traces, and before 1.3.0 their log lines carry no trace. Their logs still show, as every application's do. Copying the files the [blueprints guide](../../../../blueprints/README.md#metrics-logs-and-traces) lists brings them up to date.
