# Monitoring

Shows how the versions that run in each company's environments are doing: their CPU, memory, requests, response times and server errors, what they write to their logs, and the traces of the requests they answer. The dashboard shows them under **Monitoring**.

Everything is kept by **place**: one application in one environment, such as Billing API in production. Every metric, log line and span carries its place, so two applications in one environment, or one application in two, never mix.

- **Metrics** go to Prometheus.
- **Traces** go to Jaeger.
- **Logs** go to Loki, from clusters. On This machine, they're read from the container.

This context reads everything back, only ever for the current company's places.

## Contents

- [Places](#places)
- [How telemetry gets here](#how-telemetry-gets-here)
- [The telemetry gateway](#the-telemetry-gateway)
- [Metrics](#metrics)
- [Logs](#logs)
- [Traces](#traces)
- [Routes](#routes)
- [For other contexts](#for-other-contexts)
- [Data separation](#data-separation)
- [Settings](#settings)
- [Not included yet](#not-included-yet)

## Places

A place's ID is made from its environment's and application's IDs, in Environments' contract `environments/telemetry.ts`, so the same pair always gives the same ID and nobody has to store it. Telemetry carries four attributes:

| Attribute | Label in Prometheus and Loki | What it is |
|---|---|---|
| `dreamdevops.place.id` | `dreamdevops_place_id` | The application in the environment |
| `dreamdevops.environment.id` | `dreamdevops_environment_id` | The environment |
| `dreamdevops.application.id` | `dreamdevops_application_id` | The application |
| `dreamdevops.company.id` | `dreamdevops_company_id` | The company. Only the gateway adds it. |

Queries always ask by place. The other labels are there for whoever runs the platform, such as to see one environment's applications together in Prometheus.

## How telemetry gets here

When a version starts, [Deployments](../deployments/README.md) gives its container the standard OpenTelemetry settings: `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_METRIC_EXPORT_INTERVAL` (15000), `OTEL_SERVICE_NAME`, the application's short name, and `OTEL_RESOURCE_ATTRIBUTES` with the place, environment and application. Those attributes are always added last, after the environment's own values, so they count. Applications started from the [blueprints](../../../../blueprints/README.md) send metrics and traces with no changes, as does any application that reads the standard settings.

**In a cluster:**

1. **Sending:** applications send OTLP to the collector the [agent](../../../agent/README.md) installs on every node, `dreamdevops-otel-collector.dreamdevops-system:4318`. Applications need nothing for logs: the collector reads every container's output from the node.
2. **Labelling:** the collector adds each resource's Kubernetes namespace, which is the application's short name, and drops the cluster's own namespaces.
3. **Forwarding:** it sends everything, compressed, to the [telemetry gateway](#the-telemetry-gateway) in the API, with the target's telemetry token.
4. **Keeping:** the gateway sends what it accepts to the platform's collector, which sends metrics to Prometheus, traces to Jaeger and logs to Loki.

**On This machine:** containers send metrics and traces straight to the platform's collector, at `LOCAL_OTLP_ENDPOINT`, and their logs are read from Docker. See [This machine](../deployments/README.md#this-machine).

Versions deployed before the platform kept telemetry send none until they're deployed again, because containers get their settings as they start.

## The telemetry gateway

`POST /api/v1/telemetry/v1/{metrics|traces|logs}` takes OTLP/HTTP in JSON, up to 8 MB each, from targets' collectors. It's the authority on where telemetry comes from:

- **Who sends:** the collector proves which target it is with a bearer telemetry token. The agent receives a fresh one with its configuration every 30 minutes, valid for 2 hours, and keeps it in the Secret `dreamdevops-telemetry`. Tokens are signed by the platform, so checking one needs no database row, but the target must still be connected or lost: a removed or disconnected target's token stops working at once.
- **Where from:** the target gives the environment and company. Each resource's namespace gives the application, among the company's own. Resources from any other namespace are dropped.
- **Labels:** any `dreamdevops.*` attribute the application sent is removed, and the place, environment, application and company are set. So no application can send as another place or company, whatever its code says.
- **Answers:** `200` with `{}` when it's taken, `401` without a valid token, `400` for anything that isn't OTLP JSON, and `404` for another kind. Larger requests are refused before they're read.

`application/telemetry-gateway.ts` does the checking, and `infrastructure/collector-telemetry-sink.ts` the forwarding.

## Metrics

Each is worked out from OpenTelemetry's standard metrics, by their names:

| Metric | From | Worked out as |
|---|---|---|
| CPU | `process.cpu.time` | The share of one CPU core used, over the last two minutes, by the busiest copy |
| Memory | `process.memory.usage` | The latest value of the busiest copy |
| Requests | `http.server.request.duration` | Requests answered each second, over the last two minutes |
| Response time | `http.server.request.duration` | The time within which 95% of requests were answered |
| Server errors | `http.server.request.duration` | The share of requests answered with a 5xx status |

An application that sends none of one shows **No data** for it, rather than zero.

- **Daily high:** each chart has a dashed line at the metric's highest value in the 24 hours before the chart's range, worked out as the chart's points are. A value above it is higher than anything the day before.
- **Limits:** CPU and memory show against what each copy's container may use at most, from the deployment that started it, such as **13% of 1 CPU**. A value at 90% of its limit or more stands out.

The definitions are in `domain/metrics.ts`, and their PromQL in `infrastructure/prometheus-metrics-store.ts`.

## Logs

Every line a version writes to its standard output or error output is a log line. The page shows the latest 500 within the chosen range, with a filter.

- **From clusters:** the collector reads them on each node, and Loki keeps them, labelled by place, for 15 days locally. So they outlive the container, and a new deployment doesn't clear them.
- **From This machine:** they're read from the container that runs now, so a new deployment starts them afresh, and stopping the application removes them.
- **JSON lines** show their level, message and trace, which opens from the line: `level` or `severity`, `msg` or `message`, and `trace_id` or a W3C `traceparent`. Other lines show as they are, and lines on the error output are marked.

`domain/logs.ts` reads each line, and `infrastructure/loki-log-store.ts` reads Loki.

## Traces

A trace follows one request through every application that works on it, as spans. Services started from the blueprints continue the trace a caller sends, in its `traceparent` header, and pass it on.

- **Listing:** a place's traces are found in Jaeger by the application's short name, and only spans carrying the place count.
- **Other companies:** only the company's own spans show. Spans from elsewhere are counted, not shown.
- **Keeping:** locally, Jaeger keeps traces in memory, so restarting it clears them.

`domain/traces.ts` sums traces up, and `infrastructure/jaeger-trace-store.ts` reads Jaeger's query API.

## Routes

All routes start with `/api/v1`. The company routes need `dashboards:view`, which every company role has, and the `monitoring` feature, and change nothing.

| Route | Purpose |
|---|---|
| `GET /company/monitoring/places` | Every place a version runs in, with its `placeId`, environment, application, `provider`, latest metrics and `limits`. `enabled` says whether the server keeps metrics, and `problem` why they couldn't be read. |
| `GET /company/monitoring/places/:id?range=1h` | One place's metrics over the last `15m`, `1h` (default), `6h` or `24h`, about 60 points each, each with its `dailyHigh` |
| `GET /company/monitoring/places/:id/logs?range=1h` | The latest 500 lines within the range, oldest first. `running` says whether a version runs there. |
| `GET /company/monitoring/places/:id/traces?range=1h` | The latest 20 traces it took part in within the range, newest first |
| `GET /company/monitoring/traces/:traceId` | One trace, by its 32-digit ID, with the company's own spans |
| `POST /telemetry/v1/:kind` | The [telemetry gateway](#the-telemetry-gateway), for targets' collectors, with a telemetry token rather than a session |

Errors use `application/problem+json`: `400` for another range or a trace ID that isn't one, `404` for an unknown place or another company's, and `503` when the server keeps no metrics, logs or traces, or a store can't answer.

## For other contexts

[Alerts](../alerts/README.md) watch these metrics through `LatestMetrics`, injected with the `LATEST_METRICS` token, in `monitoring/services.ts` in the [contracts](../../../../packages/contracts/README.md), with the metrics' definitions in `monitoring/metrics.ts`. It answers for the current company only, whichever places it's given. The routes' answers are in `monitoring/http.ts`.

## Data separation

- **Asking:** the places come from [Deployments](../deployments/README.md), in the current company, under row-level security. Queries name those places' IDs and nothing else, checked before they go into a query.
- **Sending from clusters:** the gateway sets every label from the token and the namespace, never from what the application says.
- **Sending from This machine:** containers send straight to the platform's collector, labelled as the platform told them. An application's own code could still send under another place's ID, if it knew it. That's one more reason This machine is for trying things out.
- **Traces** can cross companies, so every span is checked, and shows only when its place belongs to the company.
- **The tools' own pages:** Prometheus (<http://localhost:9090>), Jaeger (<http://localhost:16686>) and Loki show every company's data, so only whoever runs the platform should reach them. Locally they listen on this machine only.
- **Logs can hold anything,** such as a secret an application logged. Only the company's members with `dashboards:view` can read them.

## Settings

| Setting | Purpose |
|---|---|
| `TELEMETRY_COLLECTOR_URL` | The platform's collector, where the gateway forwards telemetry, such as `http://localhost:4318`. Without it, the gateway checks telemetry and drops it. |
| `PROMETHEUS_URL` | Where the API reads metrics, such as `http://localhost:9090`. Without it, the dashboard says metrics aren't set up, and lists what runs anyway. |
| `JAEGER_URL` | Where the API reads traces, such as `http://localhost:16686` |
| `LOKI_URL` | Where the API reads cluster logs, such as `http://localhost:3100` |
| `TARGET_OTLP_ENDPOINT` | Where applications in clusters send OTLP. The agent's collector by default; `off` sends nothing. |
| `LOCAL_OTLP_ENDPOINT` | Where applications on This machine send OTLP, as containers reach it, such as `http://host.docker.internal:4318` |

`npm run start:api` sets them all for the local stack in [`infra/local`](../../../../infra/local/README.md#telemetry).

## Not included yet

- **Logs as metrics:** Loki keeps the lines, but nothing counts them, such as errors each minute.
- **Traces from browsers:** a trace starts at the API, not in the browser.
- **Checked senders on This machine:** see [Data separation](#data-separation).
- **Retention by company:** every company's telemetry is kept for as long as the stores keep it.
