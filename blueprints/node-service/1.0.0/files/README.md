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
| Telemetry | Traces and metrics over OTLP, sent only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set |

## Branches

Work on `feature/*` branches and open a pull request into `develop`. A Tech Lead approves it. Releases and hotfixes are started from the DreamDevOps dashboard, which creates the branches and version tags. Nobody pushes to `develop` or `main` directly.

## Database changes

When you add a database, change its schema in two steps: first add the new structure while the old code still works with it, then remove the old structure in a later release. A rollback can't undo a destructive change, so each version must keep working with the schema of the one before.
