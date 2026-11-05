# Application Catalog

Knows which kinds of application DreamDevOps supports, and what each needs. Companies register each application as one of these types, and the type says how DreamDevOps installs, checks, builds and runs it.

## Types

| Type | Key | Runtime | Served as | Frameworks |
|---|---|---|---|---|
| TypeScript frontend | `typescript-frontend` | Node.js 24 | Static files built into `dist/` | Angular, React, Vue, Svelte |
| Python frontend | `python-frontend` | Python 3.13 | A process on port 8000, checked at `/` | Streamlit, Reflex, NiceGUI |
| TypeScript backend | `typescript-backend` | Node.js 24 | A process on port 3000, checked at `/health` | NestJS, Express, Fastify |
| Python backend | `python-backend` | Python 3.13 | A process on port 8000, checked at `/health` | FastAPI, Django, Flask |

A framework that isn't listed works too, as long as the repository supports its type's commands.

## Commands

Each command runs from the root of the application's repository. A type has a start command only if a process serves it, and a migrate command only if its layer may own a database.

| Step | TypeScript | Python |
|---|---|---|
| Install | `npm ci` | `uv sync --frozen` |
| Lint | `npm run lint` | `uv run ruff check .` |
| Test | `npm test` | `uv run pytest` |
| Build | `npm run build` | None |
| Migrate (backends) | `npm run migrate` | `uv run migrate` |
| Start (processes) | `npm start` | `uv run app` |

For Python, `app` and `migrate` are project scripts in `pyproject.toml`. A process must listen on its type's port.

## Scaffolds

Each application starts from a scaffold of its type, or from an empty repository. DreamDevOps fills the scaffold in with the application's name, slug and description, and adds it to the application's repository as one commit, through Forgejo's API.

| Type | Scaffold | What it comes with |
|---|---|---|
| TypeScript frontend | Angular | Standalone components, signals and routing, component tests with Vitest and jsdom, ESLint with angular-eslint and its accessibility rules, Prettier |
| TypeScript frontend | React | React with Vite, component tests with Vitest and Testing Library, oxlint with the React Hooks and accessibility rules, Prettier |
| Python frontend | Streamlit | A page with a chart, page tests with Streamlit's AppTest, Ruff, uv |
| TypeScript backend | NestJS | `/health`, settings from the environment, a notes resource in PostgreSQL, SQL migrations with node-pg-migrate, unit tests with Vitest and HTTP tests with Supertest, oxlint, Prettier |
| Python backend | FastAPI | `/health`, settings from the environment, a notes resource in PostgreSQL, Alembic migrations with SQLAlchemy and psycopg, tests with FastAPI's TestClient, Ruff, uv |

Every scaffold has a lockfile, so installs are the dependencies that were verified. Backends run without a database: `/health` says it isn't configured, the notes answer 503, and migrating does nothing until `DATABASE_URL` is set.

### How a scaffold is filled in

A scaffold is a folder in [`apps/api/scaffolds`](../../scaffolds), named after its key. Three placeholders fill it in:

| Placeholder | Becomes | Where it may appear |
|---|---|---|
| `__APP_SLUG__` | The application's slug | Any file |
| `__APP_NAME__` | The application's name | `.json`, `.html` and `.md` files only |
| `__APP_DESCRIPTION__` | The application's description | `.json`, `.html` and `.md` files only |

Names and descriptions can hold any character, so they go only where they can be escaped exactly: as JSON strings, as HTML text, or as Markdown text. Code reads them from the scaffold's `about.json`, so no name can break it. A scaffold holds only text files, so icons are SVG.

### Keeping scaffolds working

Run these from `apps/api`:

| Command | What it does |
|---|---|
| `npm run scaffolds:verify` | Fills in each scaffold with a name full of special characters, and runs its type's commands: install, lint, test and build, then migrates, starts it and checks its health. Add keys to check only some. |
| `npm run scaffolds:lock` | Writes each scaffold's lockfile again from its dependencies |
| `npm run scaffolds:check -- <type> <folder>` | Runs a type's commands in any checkout, such as an application's repository |

`verify` needs npm, uv and Python 3.13. Set `VERIFY_DATABASE_URL` to a PostgreSQL server, such as `postgres://user:password@localhost:5433/postgres`, to migrate a real database and check health with it. Otherwise those steps are skipped. It also runs each scaffold's own formatter check.

Don't run a formatter over a scaffold's folder. It can rewrite a placeholder, such as Markdown reading `__APP_NAME__` as bold. Format a filled-in copy instead, and the tests refuse any placeholder a formatter has rewritten.

### Adding a scaffold

1. Make the project in a folder of `apps/api/scaffolds`, named after its key, using the placeholders above. Give it an `about.json` with the name and description.
2. Make sure its repository supports its type's commands, and that a process listens on the type's port unless `PORT` says otherwise.
3. Define it in `catalog/scaffolds/`, such as `vue.ts`, and add it to its type's `scaffolds`.
4. Run `npm run scaffolds:lock -- vue`, then `npm run scaffolds:verify -- vue`.

The tests check every scaffold against its type without installing anything: its commands exist, its lockfile matches, its placeholders are intact and its files fill in cleanly. The API refuses to start if a scaffold in the catalog has no folder.

## How the catalog is made

The catalog is code in [`catalog/`](catalog), built from two parts:

| Part | Holds | Files |
|---|---|---|
| Language | The runtime, its container image, the commands, and the default port | `catalog/languages/` |
| Layer | What an application does, and whether it may own a database | `catalog/layers.ts` |

A type combines one of each, and says only what is special about it: a description, frameworks, scaffolds, and how it's served. `defineApplicationType()` takes the language's commands that apply, and can replace any of them.

The API checks every type when it starts, and refuses to start if one breaks a rule. A key is unique, and is lowercase letters and digits with single hyphens. Every command has text. A process has a start command, a port and a health check path. Built files have a build command and a folder inside the repository. Only a layer that may own a database has migrations.

## Adding a type

1. Add a file to `catalog/types/`, such as `go-backend.ts`:

   ```ts
   export const GO_BACKEND = defineApplicationType({
     language: GO,
     layer: BACKEND,
     description: 'A Go service or API that may own a database.',
     frameworks: ['Gin', 'Echo'],
     serving: { kind: 'process', healthCheckPath: '/health' },
   });
   ```

2. List it in [`catalog/index.ts`](catalog/index.ts).

That's all. The tests run every listed type through the catalog's rules, and the dashboard shows it in the type picker and on the **Application types** page.

Its key is `<language>-<layer>`, such as `go-backend`. To offer a second type in the same language and layer, set `key` and `name`, such as `typescript-frontend-ssr` for pages rendered by Node.js.

## Adding a language

Add a file to `catalog/languages/` with the runtime, container image, commands and default port, then add types that use it. [`python.ts`](catalog/languages/python.ts) is an example.

## Adding a layer

Add it to [`catalog/layers.ts`](catalog/layers.ts), with a name, a description, where it appears in lists, and whether it may own a database. Then add types that use it. The dashboard groups types by layer, so it shows a new layer with no change.

## Rules for changing the catalog

- **Keys are permanent:** each application stores its type's key, so a published key must never change or be reused.
- **Removing a type** leaves its applications with a key the catalog no longer has. The dashboard shows the key, and nobody can register new applications as that type.
- **Changing a command** changes it for every application of that type.

## Routes

| Route | Who | Purpose |
|---|---|---|
| `GET /application-types` | Signed in | Every type, ordered by layer, then by language |

The catalog holds nothing about any company, so anyone signed in may read it.

## Other modules

Tenancy registers each application as a type and a scaffold. It asks the catalog which types and scaffolds exist, through its `ApplicationTypes` port, and has the catalog fill a scaffold in, through its `ScaffoldRenderer` port. It depends on the catalog's answers, not on how the catalog is made. Modules that later build, test, migrate, run and monitor applications will read their type's commands and serving from `ApplicationTypeRegistry`.
