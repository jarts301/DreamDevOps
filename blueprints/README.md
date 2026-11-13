# Blueprints

A blueprint is the starting point of a new application. It holds the scaffold committed into the application's new repository: code, tests, linting, a Dockerfile, a Compose file and the standard pipeline. A type of application can have several, one for each language and framework, and whoever registers an application chooses one.

| Blueprint | Application type | Language | What it starts with |
|---|---|---|---|
| `node-service` | RESTful Service | TypeScript | Fastify and Node.js 24, with health checks, OpenTelemetry metrics and traces, and JSON logs |
| `angular-frontend` | Web Frontend | TypeScript | Angular 22 |
| `react-typescript-frontend` | Web Frontend | TypeScript | React 19, built with Vite |
| `vue-typescript-frontend` | Web Frontend | TypeScript | Vue 3, built with Vite |
| `svelte-typescript-frontend` | Web Frontend | TypeScript | Svelte 5, built with Vite |
| `react-javascript-frontend` | Web Frontend | JavaScript | React 19, built with Vite |
| `vue-javascript-frontend` | Web Frontend | JavaScript | Vue 3, built with Vite |
| `svelte-javascript-frontend` | Web Frontend | JavaScript | Svelte 5, built with Vite |
| `pyscript-frontend` | Web Frontend | Python | PyScript 0.7, which runs Python in the browser on Pyodide, CPython compiled to WebAssembly |

Every web frontend is served by nginx, with settings read at runtime, CPU and memory metrics, JSON request logs, and traces started for API calls, so the platform deploys and monitors them all the same way. Each has the same page to start from, with **Check the API**, and tests for it.

Every scaffold pins its base images by digest, installs from a lockfile, and runs as a non-root user with a read-only file system. From version 1.1.0 of the first two, and from 1.0.0 of the others, their images also apply the security fixes Alpine released after the base image, with `apk upgrade`, so building again fixes vulnerabilities a newer package fixes. Applications started from 1.0.0 of the first two can add the same lines to their `Dockerfile`.

## Languages and frameworks

| Language | How it's checked | Frameworks |
|---|---|---|
| TypeScript | TypeScript, ESLint and Vitest, or Angular's own tools | Angular, React, Vue, Svelte |
| JavaScript | ESLint and Vitest, and TypeScript reads the JSDoc comments, so types are checked too | React, Vue, Svelte |
| Python | Ruff and Pyright, and unittest, run in Pyodide | PyScript |

- **Python without Python:** the PyScript scaffold runs everything on Node.js: the tests run in Pyodide, the same Python as the browser, and Ruff runs as WebAssembly. So its pipeline and image use the same pinned Node.js image as the others. The app serves PyScript and Pyodide itself, rather than from a CDN. Its Python starts a few seconds after the page, once the browser has Pyodide, about 13 MB, which it keeps.
- **TypeScript 6:** the scaffolds use TypeScript 6, as Angular, `vue-tsc` and `svelte-check` don't support TypeScript 7 yet.
- **Python servers:** frameworks that run Python on the server, such as Streamlit, Dash or NiceGUI, need a Python base image, pinned by digest like every other. None is pinned yet, so none is offered.

## Choosing one

The application types route lists each type's `blueprints`, and registering takes the chosen one's key as `blueprint`. Without one, an application starts from its type's first blueprint by key, which is `angular-frontend` for a web frontend, as before there was a choice. Applications keep the blueprint chosen, and their repository starts from its newest version. See the [Application Catalog](../apps/api/src/catalog/README.md#applications).

To offer a new framework, add a blueprint of the type, with its `language` and `framework` in `blueprint.json`. The registration form groups blueprints by language, and lists each `framework`.

## Metrics, logs and traces

Applications send what the dashboard shows under [Monitoring](../apps/api/src/monitoring/README.md), with OpenTelemetry's standard names and settings, so nothing in them is tied to DreamDevOps. Metrics came in 1.2.0 of the first two, and logs and traces in 1.3.0. Blueprints made since had them from 1.0.0:

| Blueprint | Metrics | Logs | Traces |
|---|---|---|---|
| `node-service` | CPU, memory, and each HTTP request's duration and status, which give requests, response times and server errors | One line of JSON per request and per log call, with its trace ID. `GET /api/ping` logs that it was called. | Each request it answers, continuing a caller's trace, and each `fetch` it makes, passing the trace on. From 1.2.0, without passing it on. |
| `angular-frontend` and every other web frontend | The container's CPU and memory | One line of JSON per request nginx serves, so opening the app's page is logged | A new trace for each call to its API, which the API continues. **Check the API** on its page tries it. |

Health checks are neither counted, logged nor traced.

### Paths in frontends' logs

Each web frontend logs the path a browser asked for, such as `GET /orders/42 200`, without its query string, which can hold secrets, from `angular-frontend` 1.3.1 and 1.0.1 of the others. Earlier versions log nginx's `$uri`, which is the file nginx ends up serving, so every visit to the app's page, at `/` or at one of its routes, shows as `GET /index.html 200`. Applications started from them can copy the `map` block and the `log_format` from the newest version's `nginx/default.conf`.

Metrics and traces go nowhere unless the platform says where, with `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, which it sets when it deploys them, along with the environment's ID in `OTEL_RESOURCE_ATTRIBUTES`. Logs go to standard output, where the platform reads them. Each scaffold's README lists its settings.

Applications started from earlier versions can copy what they lack from the newest version:

| Blueprint | Files |
|---|---|
| `node-service` | `src/telemetry.ts`, `src/metrics.ts`, `src/logging.ts`, the logger settings in `src/app.ts`, and the `@opentelemetry/api` and `@opentelemetry/instrumentation-undici` dependencies |
| `angular-frontend` | `nginx/send-metrics.sh` and its `Dockerfile` line, the `map` block and `log_format` in `nginx/default.conf`, and `src/app/trace-context.ts` with its line in `src/app/app.config.ts` |
| The other web frontends, from 1.0.0 | The `map` block and `log_format` in `nginx/default.conf` |

## Layout

Each version is a folder, `<key>/<version>/`, holding:

| Item | Purpose |
|---|---|
| `blueprint.json` | What the blueprint defines: its type, language, runtime profile, telemetry, pipeline and deployment strategies |
| `files/` | The scaffold, copied as it is into new repositories |

New applications start from the newest version of the blueprint chosen for them. Each repository records the version it started from.

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

## Lockfiles

Each scaffold's `package-lock.json` must list every platform's native packages, such as Vite's `@rolldown/binding-linux-x64-musl`, which images need, as they build on Alpine, and `darwin` and `win32` ones, which people need on their own computers. npm only lists those the registry has for every platform, so make a lockfile against the public npm registry, not a partial mirror. `npm test` checks every scaffold's lockfile has them all.
