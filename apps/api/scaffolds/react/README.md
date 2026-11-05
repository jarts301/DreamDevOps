# __APP_NAME__

__APP_DESCRIPTION__

A React app built with Vite, started from the DreamDevOps React scaffold. DreamDevOps installs, lints, tests and builds it with the commands below, and serves what the build puts in `dist/`.

## Commands

| Command          | What it does                                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| `npm ci`         | Installs the exact dependencies in `package-lock.json`                         |
| `npm run dev`    | Serves the app at <http://localhost:5173> and reloads on changes               |
| `npm run lint`   | Checks the code with oxlint, including the React Hooks and accessibility rules |
| `npm test`       | Runs the component tests with Vitest, Testing Library and jsdom                |
| `npm run build`  | Checks the types and builds the app for production into `dist/`                |
| `npm run format` | Formats the code with Prettier                                                 |

Node.js 24 or later is needed.

## Layout

| Path              | Contents                                   |
| ----------------- | ------------------------------------------ |
| `src/about.json`  | The app's name and description             |
| `src/App.tsx`     | The page                                   |
| `src/components/` | Components, each with its tests next to it |
| `public/`         | Files served as they are, such as the icon |
