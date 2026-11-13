# Blueprints

A blueprint is the starting point of a new application. It holds the scaffold committed into the application's new repository: code, tests, linting, a Dockerfile, a Compose file and the standard pipeline. A type of application can have several, one for each language and framework, and whoever registers an application chooses one.

| Blueprint | Application type | Language | What it starts with |
|---|---|---|---|
| `node-service` | RESTful Service | TypeScript | Fastify and Node.js 24, with health checks, OpenTelemetry metrics and traces, and JSON logs |
| `express-typescript-service` | RESTful Service | TypeScript | Express 5 and Node.js 24 |
| `nestjs-typescript-service` | RESTful Service | TypeScript | NestJS and Node.js 24 |
| `express-javascript-service` | RESTful Service | JavaScript | Express 5 and Node.js 24 |
| `fastify-javascript-service` | RESTful Service | JavaScript | Fastify 5 and Node.js 24 |
| `fastapi-python-service` | RESTful Service | Python | FastAPI, served by Uvicorn |
| `flask-python-service` | RESTful Service | Python | Flask 3, served by Waitress |
| `axum-rust-service` | RESTful Service | Rust | Axum, on Tokio |
| `actix-web-rust-service` | RESTful Service | Rust | Actix Web 4 |
| `httplib-cpp-service` | RESTful Service | C++ | cpp-httplib, on C++20, built with CMake |
| `angular-frontend` | Web Frontend | TypeScript | Angular 22 |
| `react-typescript-frontend` | Web Frontend | TypeScript | React 19, built with Vite |
| `vue-typescript-frontend` | Web Frontend | TypeScript | Vue 3, built with Vite |
| `svelte-typescript-frontend` | Web Frontend | TypeScript | Svelte 5, built with Vite |
| `react-javascript-frontend` | Web Frontend | JavaScript | React 19, built with Vite |
| `vue-javascript-frontend` | Web Frontend | JavaScript | Vue 3, built with Vite |
| `svelte-javascript-frontend` | Web Frontend | JavaScript | Svelte 5, built with Vite |
| `pyscript-frontend` | Web Frontend | Python | PyScript 0.7, which runs Python in the browser on Pyodide, CPython compiled to WebAssembly |

Every service answers the same routes, `/health/live`, `/health/ready`, `/api/ping` and `/api/hello`, reads the same settings, such as `PORT` and `CORS_ORIGINS`, sends the same metrics and traces, and logs the same JSON lines, with their trace, so the platform deploys and monitors them all the same way, and a frontend's **Check the API** works with any of them. Each has tests of all that, in its language.

Every web frontend is served by nginx, with settings read at runtime, CPU and memory metrics, JSON request logs, and traces started for API calls, so the platform deploys and monitors them all the same way. Each has the same page to start from, with **Check the API**, and tests for it.

Every scaffold pins its base images by digest, installs only what its lockfile says, checked against its checksums, and runs as a non-root user with a read-only file system. From version 1.1.0 of the first two, and from 1.0.0 of the others, their images also apply the security fixes Alpine released after the base image, with `apk upgrade`, so building again fixes vulnerabilities a newer package fixes. Applications started from 1.0.0 of the first two can add the same lines to their `Dockerfile`.

### What service images hold

From `node-service` 1.3.1 and 1.0.1 of the other services, a service's image holds only what it runs with. See [Fixing existing applications](#fixing-existing-applications) for applications started earlier.

- **No npm or Yarn:** the Node.js base image brings npm, npx, Corepack and Yarn, with packages of their own, such as `undici` and `brace-expansion`. Scanners report their vulnerabilities, which `apk upgrade` can't fix, as they aren't Alpine packages. Services don't run them, so the image removes them. Services in Python, Rust and C++ don't need Node.js either, so it goes too.
- **No `package.json` named after the application:** a project's `package.json` is named after the application, and an application can share its name with a published package, such as `fastify`. Scanners then report that package's vulnerabilities for it: an application called *Fastify* failed its scan with `CVE-2018-3711 in fastify 0.1.0`. Node.js only needs to know the code is ES modules, so the image gets a `package.json` that says only that.
- **Rust builds that fit in memory:** the Rust services' images compile four crates at a time, about 1.2 GB at most, rather than one per CPU, which can take more memory than Docker gives builds on a laptop. They download their crates in a step of their own, and try again, one connection at a time, when the network drops some.

## Languages and frameworks

| Language | How it's checked | Services | Web frontends |
|---|---|---|---|
| TypeScript | TypeScript, ESLint and Vitest, or Angular's own tools | Fastify, Express, NestJS | Angular, React, Vue, Svelte |
| JavaScript | ESLint and Vitest, and TypeScript reads the JSDoc comments, so types are checked too | Express, Fastify | React, Vue, Svelte |
| Python | Ruff, strict mypy and pytest, for services. Ruff, Pyright and unittest, run in Pyodide, for PyScript. | FastAPI, Flask | PyScript |
| Rust | rustfmt, Clippy, with every warning an error, and `cargo test` | Axum, Actix Web | |
| C++ | GCC, with every warning an error, and doctest | cpp-httplib | |

- **Python without Python:** the PyScript scaffold runs everything on Node.js: the tests run in Pyodide, the same Python as the browser, and Ruff runs as WebAssembly. So its pipeline and image use the same pinned Node.js image as the others. The app serves PyScript and Pyodide itself, rather than from a CDN. Its Python starts a few seconds after the page, once the browser has Pyodide, about 13 MB, which it keeps.
- **TypeScript 6:** the scaffolds use TypeScript 6, as Angular, `vue-tsc` and `svelte-check` don't support TypeScript 7 yet.
- **One base image:** the platform pins one Alpine image by digest, Node.js's, and the Python, Rust and C++ services build and run on it too, with Python, Rust or GCC from Alpine's own packages. Their pipelines run in it as well. Each `Dockerfile` says how to move to an official image of its language, pinned by digest, once one is.
- **Rust version:** Rust comes from Alpine, so it's as new as the Alpine release in the base image, 1.83 or newer. The Rust services say so in `rust-version`, and their dependencies are locked to versions that build with it. Each README says how to move on.
- **C++ libraries:** C++ has no package registry to lock against, so `httplib-cpp-service` keeps its two libraries, cpp-httplib and doctest, in `third_party`, each a single header, with their checksums in `third_party/SHA256SUMS`, which its pipeline checks. Frameworks such as Drogon or Crow need more libraries beside them, such as Trantor or Asio, to be built or kept too, so the first C++ blueprint starts from cpp-httplib, which needs nothing else.

## Choosing one

The application types route lists each type's `blueprints`, and registering takes the chosen one's key as `blueprint`. Without one, an application starts from its type's default, which each type names in the catalog: `node-service` for a RESTful service and `angular-frontend` for a web frontend, as before there was a choice. Applications keep the blueprint chosen, and their repository starts from its newest version. See the [Application Catalog](../apps/api/src/catalog/README.md#applications).

To offer a new framework, add a blueprint of the type, with its `language` and `framework` in `blueprint.json`. The registration form groups blueprints by language, and lists each `framework`.

## Metrics, logs and traces

Applications send what the dashboard shows under [Monitoring](../apps/api/src/monitoring/README.md), with OpenTelemetry's standard names and settings, so nothing in them is tied to DreamDevOps. Metrics came in 1.2.0 of the first two, and logs and traces in 1.3.0. Blueprints made since had them from 1.0.0:

| Blueprint | Metrics | Logs | Traces |
|---|---|---|---|
| `node-service` | CPU, memory, and each HTTP request's duration and status, which give requests, response times and server errors | One line of JSON per request and per log call, with its trace ID. `GET /api/ping` logs that it was called. | Each request it answers, continuing a caller's trace, and each `fetch` it makes, passing the trace on. From 1.2.0, without passing it on. |
| Every other service, from 1.0.0 | The same as `node-service` | The same as `node-service` | Each request it answers, continuing a caller's trace. Its README says how to pass the trace on to the services it calls. |
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

### Fixing existing applications

Applications started from `node-service` 1.3.0 or earlier, or from 1.0.0 of the other services, keep their `Dockerfile`. To fix their images, replace their `Dockerfile` with the newest version's, through a pull request into `develop`, as with any change. Nothing else changes.

| Blueprint | What the new `Dockerfile` fixes |
|---|---|
| Services in TypeScript and JavaScript | Scans report npm's and Yarn's packages, and, for an application named like a published package, that package's vulnerabilities |
| Services in Python and C++ | Scans report npm's and Yarn's packages |
| Services in Rust | The same, and builds that run out of memory or lose their downloads |

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

Then check that every version still produces a working project. This runs each scaffold's own pipeline, step by step, in a container of the pipeline's image, as Forgejo would, builds its image, runs it until the health check passes, and checks the container sends its metrics, from 1.2.0, and logs and traces a request, from 1.3.0. It needs Docker and the internet, and takes a while, as the Rust and C++ services compile:

```bash
npm run test:scaffolds
```

Line endings are always LF, set in `.gitattributes`, so checksums match on every operating system.

## Lockfiles

Each scaffold locks its dependencies, with their checksums, in its language's own way, and `npm test` checks them:

| Language | Lockfile | Made with |
|---|---|---|
| TypeScript, JavaScript | `package-lock.json` | `npm install` |
| Python | `requirements.txt`, and `requirements-dev.txt` with what the checks need | `uv pip compile --universal --generate-hashes`, as each README shows |
| Rust | `Cargo.lock` | `cargo generate-lockfile`, with `.cargo/config.toml` picking versions that build with the `rust-version` |
| C++ | `third_party/SHA256SUMS` | `sha256sum` of the headers kept in `third_party` |

Each `package-lock.json` must list every platform's native packages, such as Vite's `@rolldown/binding-linux-x64-musl`, which images need, as they build on Alpine, and `darwin` and `win32` ones, which people need on their own computers. npm only lists those the registry has for every platform, so make a lockfile against the public npm registry, not a partial mirror. The same goes for Python: every package must have a wheel for Alpine, `musllinux`, on x86-64 and ARM, as images install nothing that has to be compiled.
