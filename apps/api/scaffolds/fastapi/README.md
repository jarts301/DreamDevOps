# __APP_NAME__

__APP_DESCRIPTION__

A FastAPI API, started from the DreamDevOps FastAPI scaffold. DreamDevOps installs, lints, tests, migrates and starts it with the commands below, and checks it at `/health`.

## Commands

| Command | What it does |
|---|---|
| `uv sync --frozen` | Installs the exact dependencies in `uv.lock` |
| `uv run uvicorn app.main:create_app --factory --reload` | Runs the API at <http://localhost:8000> and restarts on changes |
| `uv run ruff check .` | Checks the code with Ruff |
| `uv run ruff format .` | Formats the code with Ruff |
| `uv run pytest` | Runs the tests, using FastAPI's TestClient |
| `uv run migrate` | Applies the migrations in `src/app/migrations` to `DATABASE_URL` |
| `uv run alembic revision -m "add a table"` | Adds a migration |
| `uv run app` | Runs the API |

Python 3.13 and [uv](https://docs.astral.sh/uv/) are needed. The API's documentation is at `/docs` while it runs.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | Where the API listens |
| `DATABASE_URL` | None | A PostgreSQL database. Without one, the API runs and `/notes` answers 503. |

## Routes

| Route | Purpose |
|---|---|
| `GET /` | The API's name and description, from `src/app/about.json` |
| `GET /health` | Whether the API and its database are up |
| `GET`, `POST /notes` | An example resource stored in the database. Replace it with your own. |
