# Monitoring

Shows how the versions that run in each company's environments are doing: their CPU, memory, requests, response times and server errors. The dashboard shows them under **Monitoring**.

Applications send their own metrics, with OpenTelemetry, to a metrics store, which is Prometheus. The platform tells each container where to send them, and which environment it is. This context reads them back, only ever for the current company's environments.

## Contents

- [How metrics get here](#how-metrics-get-here)
- [Metrics](#metrics)
- [Routes](#routes)
- [Data separation](#data-separation)
- [Settings](#settings)
- [Not included yet](#not-included-yet)

## How metrics get here

1. **Deploying:** when a container starts, [Environments](../environments/README.md#variables-and-secrets) gives it the standard OpenTelemetry settings: `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, where to send metrics, and `OTEL_RESOURCE_ATTRIBUTES` with `dreamdevops.environment.id`, the environment's ID.
2. **Sending:** the application sends its metrics there over OTLP every 15 seconds. Applications started from the [blueprints](../../../../blueprints/README.md) from version 1.2.0 do it with no changes. Any other application that uses OpenTelemetry does too, as long as it reads the standard settings.
3. **Keeping:** Prometheus receives them, and turns the environment's attribute into the label `dreamdevops_environment_id`, as [its settings](../../../../infra/local/prometheus/prometheus.yml) ask.
4. **Reading:** this context asks [Environments](../environments/README.md) what runs where, through `RunningEnvironments`, and asks Prometheus for those environments' metrics, by that label.

Versions deployed before the platform kept metrics send none until they're deployed again, because containers get their settings as they start.

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

## Routes

All routes start with `/api/v1`, need `dashboards:view`, which every company role has, and need the `monitoring` feature, which every edition includes. They change nothing.

| Route | Purpose |
|---|---|
| `GET /company/monitoring/environments` | Every active environment a version runs in, by application, with its latest metrics. `enabled` says whether the server keeps metrics, and `problem` why they couldn't be read, if they couldn't. The environments are listed either way. |
| `GET /company/monitoring/environments/:id?range=1h` | One environment's metrics over the last `15m`, `1h` (default), `6h` or `24h`, about 60 points each, for charts. Steps where the application sent nothing have no point. |

Errors use the API's `application/problem+json` format: `400` for another range, `404` for an unknown environment or another company's, and `503` when the server keeps no metrics or Prometheus can't answer.

## Data separation

- **Asking:** the list of environments comes from Environments, in the current company, under row-level security. Every query to Prometheus names those environments' IDs and nothing else, so it can't return another company's metrics. IDs are checked as UUIDs before they go into a query.
- **Sending:** metrics are labelled by what the application sends. The platform adds the environment's attribute last, after any of the environment's own, so it counts. But an application's own code could still send metrics under another environment's ID, if it knew it, and they'd show on that environment's charts. That's one more reason [This machine](../environments/README.md#this-machine) is for trying things out and small teams.
- **Prometheus itself:** its own page, at <http://localhost:9090> locally, shows every company's metrics, so only whoever runs the machine should reach it. Locally it accepts connections only from this machine, but [applications on This machine can reach it](../environments/README.md#this-machine) through `host.docker.internal`, as they must to send metrics.

## Settings

| Setting | Purpose |
|---|---|
| `PROMETHEUS_URL` | Where the API reads metrics, such as `http://localhost:9090`. Without it, the dashboard says metrics aren't set up, and lists what runs anyway. |
| `APP_METRICS_OTLP_ENDPOINT` | Where containers send metrics, as they reach it, such as `http://host.docker.internal:9090/api/v1/otlp/v1/metrics`. Without it, containers aren't told to send any. |

`npm run start:api` sets both for the local Prometheus. Metrics are kept for `METRICS_RETENTION`, 15 days by default.

## Not included yet

- **Logs, traces and alerts:** the `monitoring` feature includes them, but only metrics are collected so far. Services can send traces to a place of their own with `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`.
- **Checked senders:** Prometheus accepts metrics from anything that reaches it, labelled as the sender says. A collector that checks each environment's own token would stop one environment sending as another.
- **Resource limits:** charts don't show the limits containers run with, such as 512 MB of memory on This machine.
- **Other providers:** only This machine deploys, so only it is monitored. Other providers will need their own way to reach the metrics store.
- **Older blueprints:** applications started from blueprint versions before 1.2.0 send no metrics. Copying `src/telemetry.ts` and `src/metrics.ts` from node-service 1.2.0, or `nginx/send-metrics.sh` and its `Dockerfile` line from angular-frontend 1.2.0, makes them send.
