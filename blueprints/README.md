# Blueprints

A blueprint is the starting point of every new application of one type. It holds the scaffold committed into the application's new repository: code, tests, linting, a Dockerfile, a Compose file and the standard pipeline.

| Blueprint | Application type | What it starts with |
|---|---|---|
| `node-service` | RESTful Service | TypeScript on Fastify and Node.js 24, with health checks, OpenTelemetry metrics and traces, and JSON logs |
| `angular-frontend` | Web Frontend | Angular 22 served by nginx, with settings read at runtime, CPU and memory metrics, JSON request logs, and traces started for API calls |

Both scaffolds pin their base images by digest, install from a lockfile, and run as a non-root user with a read-only file system. From version 1.1.0, their images also apply the security fixes Alpine released after the base image, with `apk upgrade`, so building again fixes vulnerabilities a newer package fixes. Applications started from 1.0.0 can add the same lines to their `Dockerfile`.

## Metrics, logs and traces

Applications send what the dashboard shows under [Monitoring](../apps/api/src/monitoring/README.md), with OpenTelemetry's standard names and settings, so nothing in them is tied to DreamDevOps. Metrics came in 1.2.0, and logs and traces in 1.3.0:

| Blueprint | Metrics | Logs | Traces |
|---|---|---|---|
| `node-service` | CPU, memory, and each HTTP request's duration and status, which give requests, response times and server errors | One line of JSON per request and per log call, with its trace ID. `GET /api/ping` logs that it was called. | Each request it answers, continuing a caller's trace, and each `fetch` it makes, passing the trace on. From 1.2.0, without passing it on. |
| `angular-frontend` | The container's CPU and memory | One line of JSON per request nginx serves, so opening the app's page is logged | A new trace for each call to its API, which the API continues. **Check the API** on its page tries it. |

Health checks are neither counted, logged nor traced.

Metrics and traces go nowhere unless the platform says where, with `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, which it sets when it deploys them, along with the environment's ID in `OTEL_RESOURCE_ATTRIBUTES`. Logs go to standard output, where the platform reads them. Each scaffold's README lists its settings.

Applications started from earlier versions can copy what they lack from the newest version:

| Blueprint | Files |
|---|---|
| `node-service` | `src/telemetry.ts`, `src/metrics.ts`, `src/logging.ts`, the logger settings in `src/app.ts`, and the `@opentelemetry/api` and `@opentelemetry/instrumentation-undici` dependencies |
| `angular-frontend` | `nginx/send-metrics.sh` and its `Dockerfile` line, the `log_format` in `nginx/default.conf`, and `src/app/trace-context.ts` with its line in `src/app/app.config.ts` |

## Layout

Each version is a folder, `<key>/<version>/`, holding:

| Item | Purpose |
|---|---|
| `blueprint.json` | What the blueprint defines: its type, language, runtime profile, telemetry, pipeline and deployment strategies |
| `files/` | The scaffold, copied as it is into new repositories |

New applications always start from the newest version for their type. Each repository records the version it started from.

## Placeholders

Text files can use these, and the platform fills them in for each application. Any other `__APP_…__` name stops the API from starting.

| Placeholder | Replaced with | Use it in |
|---|---|---|
| `__APP_SLUG__` | The application's short name, such as `billing-api` | Package names, image names |
| `__APP_NAME__` | The name as entered | Markdown |
| `__APP_NAME_HTML__` | The name, escaped for HTML | HTML |
| `__APP_NAME_JSON__` | The name as a quoted JSON string | JSON, JavaScript and TypeScript |

## Publishing a version

A published version never changes, because applications already started from it. `published.json` records a checksum of each version, and the API refuses to start if a published version changed or a version isn't published.

To change a blueprint, copy its newest folder to a new version number, change the copy, update `version` in its `blueprint.json`, and then publish it:

```bash
npm run blueprints:publish
```

Then check that every version still produces a working project. This installs, lints, tests and builds each scaffold, runs its image until the health check passes, and checks the container sends its metrics, from 1.2.0, and logs and traces a request, from 1.3.0. It needs Docker and the internet, and takes a few minutes:

```bash
npm run test:scaffolds
```

Line endings are always LF, set in `.gitattributes`, so checksums match on every operating system.
