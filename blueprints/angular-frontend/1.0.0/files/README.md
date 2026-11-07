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

## Branches

Work on `feature/*` branches and open a pull request into `develop`. A Tech Lead approves it. Releases and hotfixes are started from the DreamDevOps dashboard, which creates the branches and version tags. Nobody pushes to `develop` or `main` directly.
