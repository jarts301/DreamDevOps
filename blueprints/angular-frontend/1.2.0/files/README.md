# __APP_NAME__

A web frontend in TypeScript, built with Angular.

## Run it

```bash
npm install
```

```bash
npm start
```

The app opens on <http://localhost:4200>.

To run it in a container, as the platform does:

```bash
docker compose up --build
```

It's then on <http://localhost:8080>.

## Checks

| Command | What it does |
|---|---|
| `npm test` | Runs the tests |
| `npm run lint` | Checks the code style |
| `npm run typecheck` | Checks the types |
| `npm run build` | Builds the app into `dist/` |

The pipeline in `.forgejo/workflows/ci.yaml` runs all of them on every push and pull request.

## Settings

The app reads its settings from `/config.json` when it starts. In development that's `public/config.json`. In the container it's written from environment variables, so one image serves every environment:

| Variable | Setting | Default |
|---|---|---|
| `API_URL` | Where the app calls its API | `/api` |

Add a setting to `runtime-config.ts`, `public/config.json` and `nginx/write-runtime-config.sh`. Never put secrets in it, because every visitor can read it.

## What the platform expects

| Item | Value |
|---|---|
| Port | `8080` |
| Health check | `GET /healthz` |
| User | Non-root, with a read-only file system except `/tmp` |
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

## Security updates

The `Dockerfile` pins its base images by digest, so every build starts from the same packages, and then applies the security fixes Alpine has released since, with `apk upgrade`. So when a scan finds a vulnerability that's fixed in a newer package, building again fixes it. To move to a newer base image, such as a new Node.js or nginx release, change its tag and digest in the `Dockerfile`.

## Branches

Work on `feature/*` branches and open a pull request into `develop`. A Tech Lead approves it. Releases and hotfixes are started from the DreamDevOps dashboard, which creates the branches and version tags. Nobody pushes to `develop` or `main` directly.
