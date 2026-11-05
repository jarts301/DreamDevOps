# __APP_NAME__

__APP_DESCRIPTION__

An Angular app, started from the DreamDevOps Angular scaffold. DreamDevOps installs, lints, tests and builds it with the commands below, and serves what the build puts in `dist/`.

## Commands

| Command          | What it does                                                                  |
| ---------------- | ----------------------------------------------------------------------------- |
| `npm ci`         | Installs the exact dependencies in `package-lock.json`                        |
| `npm start`      | Serves the app at <http://localhost:4200> and reloads on changes              |
| `npm run lint`   | Checks the code with ESLint and angular-eslint, including accessibility rules |
| `npm test`       | Runs the component tests with Vitest and jsdom                                |
| `npm run build`  | Builds the app for production into `dist/`                                    |
| `npm run format` | Formats the code with Prettier                                                |

Node.js 24 or later is needed.

## Layout

| Path                            | Contents                                       |
| ------------------------------- | ---------------------------------------------- |
| `src/about.json`                | The app's name and description                 |
| `src/app/app.ts`                | The page frame and navigation                  |
| `src/app/app.routes.ts`         | The pages and their addresses                  |
| `src/app/home`, `src/app/about` | One folder per page, with its tests next to it |
| `public/`                       | Files served as they are, such as the icon     |
