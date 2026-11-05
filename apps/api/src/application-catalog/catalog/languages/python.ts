import type { Language } from '../../domain/application-type.ts';

/**
 * uv manages the project. The conventions are Ruff and pytest, and the project scripts
 * "app" and "migrate" in pyproject.toml.
 */
export const PYTHON: Language = {
  key: 'python',
  name: 'Python',
  runtime: { name: 'Python', version: '3.13', image: 'python:3.13-slim' },
  commands: {
    install: 'uv sync --frozen',
    lint: 'uv run ruff check .',
    test: 'uv run pytest',
    start: 'uv run app',
    migrate: 'uv run migrate',
  },
  defaultPort: 8000,
};
