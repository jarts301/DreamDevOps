# __APP_NAME__

__APP_DESCRIPTION__

A NestJS API, started from the DreamDevOps NestJS scaffold. DreamDevOps installs, lints, tests, builds, migrates and starts it with the commands below, and checks it at `/health`.

## Commands

| Command                          | What it does                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `npm ci`                         | Installs the exact dependencies in `package-lock.json`                                 |
| `npm run start:dev`              | Runs the API at <http://localhost:3000> and restarts on changes                        |
| `npm run lint`                   | Checks the code with oxlint, including type-aware rules                                |
| `npm test`                       | Runs the unit tests and the end-to-end tests of the HTTP API with Vitest and Supertest |
| `npm run build`                  | Compiles the API into `dist/`                                                          |
| `npm run migrate`                | Applies the migrations in `migrations/` to `DATABASE_URL`                              |
| `npm run migrate:create -- name` | Adds a SQL migration                                                                   |
| `npm start`                      | Runs the compiled API                                                                  |
| `npm run format`                 | Formats the code with Prettier                                                         |

Node.js 24 or later is needed.

## Settings

| Variable       | Default | Purpose                                                                    |
| -------------- | ------- | -------------------------------------------------------------------------- |
| `PORT`         | `3000`  | Where the API listens                                                      |
| `DATABASE_URL` | None    | A PostgreSQL database. Without one, the API runs and `/notes` answers 503. |

## Routes

| Route                | Purpose                                                               |
| -------------------- | --------------------------------------------------------------------- |
| `GET /`              | The API's name and description, from `src/about.json`                 |
| `GET /health`        | Whether the API and its database are up                               |
| `GET`, `POST /notes` | An example resource stored in the database. Replace it with your own. |
