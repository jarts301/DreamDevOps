# __APP_NAME__

__APP_DESCRIPTION__

A Streamlit app, started from the DreamDevOps Streamlit scaffold. DreamDevOps installs, lints, tests and starts it with the commands below, and checks that it answers at `/`.

## Commands

| Command | What it does |
|---|---|
| `uv sync --frozen` | Installs the exact dependencies in `uv.lock` |
| `uv run app` | Runs the app at <http://localhost:8000>. Set `PORT` to use another port. |
| `uv run ruff check .` | Checks the code with Ruff |
| `uv run ruff format .` | Formats the code with Ruff |
| `uv run pytest` | Runs the tests, including page tests with Streamlit's AppTest |

Python 3.13 and [uv](https://docs.astral.sh/uv/) are needed. Streamlit reloads the page when its file changes, so you see edits as you save them.

## Layout

| Path | Contents |
|---|---|
| `src/app/about.json` | The app's name and description |
| `src/app/page.py` | The page |
| `src/app/data.py` | Example data for the page |
| `tests/` | Tests of the data and of the page |
| `.streamlit/config.toml` | Streamlit's settings |
