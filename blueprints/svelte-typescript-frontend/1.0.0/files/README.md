# __APP_NAME__

A web frontend in TypeScript, built with Svelte and Vite.

## Run it

```bash
npm install
```

```bash
npm start
```

The app opens on <http://localhost:5173>. It reloads as you change the code.

To run it in a container, as the platform does:

```bash
docker compose up --build
```

It's then on <http://localhost:8080>.

## Checks

| Command | What it does |
|---|---|
| `npm test` | Runs the tests, with Vitest |
| `npm run lint` | Checks the code style, with ESLint |
| `npm run typecheck` | Checks the types, with svelte-check |
| `npm run build` | Builds the app into `dist/` |

The pipeline in `.forgejo/workflows/ci.yaml` runs all of them on every push and pull request.

## Layout

| File | Purpose |
|---|---|
| `src/main.ts` | Reads the settings, then starts the app |
| `src/App.svelte` | The app |
| `src/App.test.ts` | The app's tests |
| `src/runtime-config.ts` | Reads the settings when the app starts |
| `src/trace-context.ts` | Starts a trace for each call to the API |
| `src/check-api.ts` | Pings the API, for **Check the API** |
| `nginx/` | How the container serves the app, sends its metrics and writes its settings |

## Settings

The app reads its settings from `/config.json` when it starts. In development that's `public/config.json`. In the container it's written from environment variables, so one image serves every environment:

| Variable | Setting | Default |
|---|---|---|
| `API_URL` | Where the app calls its API | `/api` |

Add a setting to `src/runtime-config.ts`, `public/config.json` and `nginx/write-runtime-config.sh`. Never put secrets in it, because every visitor can read it.

## What the platform expects

| Item | Value |
|---|---|
| Port | `8080` |
| Health check | `GET /healthz` |
| User | Non-root, with a read-only file system except `/tmp` |
| Logs | One line of JSON per request on standard output, which the platform shows under **Monitoring**. See [Logs](#logs). |
| Telemetry | CPU and memory over OTLP, which the platform asks for and shows under **Monitoring**. See [Metrics](#metrics). |

## Metrics

When it runs on the platform, the container sends its CPU and memory use every 15 seconds, with OpenTelemetry's standard names, `process.cpu.time` and `process.memory.usage`, so any tool that reads OpenTelemetry shows them. They're the container's, read from its cgroup, which holds only nginx.

`nginx/send-metrics.sh` sends them. nginx starts it, and it sends nothing unless told where, with the standard `OTEL_*` variables:

| Variable | Purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Where metrics go. The platform sets it. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Another way to say where, which gets `/v1/metrics` added |
| `OTEL_METRIC_EXPORT_INTERVAL` | Milliseconds between sends, 15000 by default |
| `OTEL_RESOURCE_ATTRIBUTES` | Attributes every metric carries. The platform adds the environment's ID, which is how it knows where metrics come from. |

If it can't send them, it says so once in the container's log, and keeps trying. nginx only serves the app's files, so it reports no requests or response times. Those come from the services the app calls.

## Logs

nginx logs each request as one line of JSON on standard output, where the platform reads it, so opening the app's page shows up, with each file it loads:

```json
{"time":"2026-11-10T12:00:00+00:00","level":"info","msg":"GET / 200","method":"GET","path":"/","status":200,"bytes":612,"duration_s":0.000,"request_id":"5f1c0d3e…","traceparent":"","referer":"","user_agent":"Mozilla/5.0 …"}
```

Health checks aren't logged. The format is `log_format json` in `nginx/default.conf`.

## Traces

Call the API with `tracedFetch(settings.apiUrl)`, from `src/trace-context.ts`, instead of `fetch`. It starts a trace for each call to the API, with a W3C `traceparent` header. The API continues it, and so do the services it calls, so one click is one trace across all of them, which the platform shows under **Monitoring**. Calls anywhere else get no header, so no trace leaks to other sites.

**Check the API**, on the app's page, in `src/App.svelte`, pings `<API_URL>/ping` and shows the trace ID it started, to look for in the API's logs and traces.

The API must let the page call it. A service started from the Node.js service blueprint, from 1.3.0, does when its `CORS_ORIGINS` variable lists this app's address, such as `http://localhost:49154`. Set this app's `API_URL` to the service's address with `/api`, such as `http://localhost:49153/api`.

The browser itself doesn't send its part of the trace yet, so a trace starts at the API, with a parent span nobody reported.

## Security updates

The `Dockerfile` pins its base images by digest, so every build starts from the same packages, and then applies the security fixes Alpine has released since, with `apk upgrade`. So when a scan finds a vulnerability that's fixed in a newer package, building again fixes it. To move to a newer base image, such as a new Node.js or nginx release, change its tag and digest in the `Dockerfile`.

## Branches

Work on `feature/*` branches and open a pull request into `develop`. A Tech Lead approves it. Releases and hotfixes are started from the DreamDevOps dashboard, which creates the branches and version tags. Nobody pushes to `develop` or `main` directly.
