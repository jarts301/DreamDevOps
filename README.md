# DreamDevOps

A self-hostable platform for managing the full lifecycle of a company's software applications, from planning through deployment and maintenance, from one dashboard.

> [!WARNING]
> **DreamDevOps is in early development and isn't ready for production.** It currently runs only on a developer's machine, using the local setup below, and every password in that setup is a public dummy value.

## Contents

- [Status](#status)
- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
- [Local services](#local-services)
- [Commands](#commands)
- [Configuration](#configuration)
- [Testing](#testing)
- [Backup and restore](#backup-and-restore)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Status

| Capability | What works today |
|---|---|
| Sign-in | Login, registration and logout through Keycloak |
| Companies | Creating named companies, provisioning their resources, suspending, reactivating and closing them, and erasing a closed company's data to meet data protection laws |
| Company resources | A private Git organization in Forgejo for each company, provisioned in the background and retried when Forgejo can't be reached |
| Application types | Registering each application as a TypeScript or Python frontend or backend, from a catalog that new types, languages and layers can be added to |
| Scaffolds | Each application's private repository in Forgejo, started with a working Angular, React, Streamlit, NestJS or FastAPI project that lints, tests, builds, migrates and runs |
| Applications | Creating, changing, archiving and restoring each company's applications, with a separate permission for each of these and for configuring, migrating, running, testing and monitoring them |
| Users and roles | Invitations, five company roles and a Platform Admin role, with changes applied on the user's next request |
| Company data separation | Enforced in the database with row-level security |
| Dashboard | Overview, applications, team management, joining a company and managing companies, in light and dark themes |

Building images, deploying, and monitoring aren't available yet.

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| [Node.js](https://nodejs.org) | 24 or later | The API, the dashboard and the tests |
| [Git](https://git-scm.com) | Current | Cloning the repository |
| npm | Included with Node.js | Installing dependencies and running commands |
| [Docker Desktop](https://www.docker.com/products/docker-desktop), or Docker Engine with Compose | Current | The local services and integration tests |
| Google Chrome | Current | The browser test only |

The first run downloads the service images and dependencies, so it needs an internet connection.

## Getting started

Run these commands from the repository root. They work in Bash and PowerShell.

1. Clone the repository:

   ```bash
   git clone git@github.com:jarts301/DreamDevOps.git
   ```

   ```bash
   cd DreamDevOps
   ```

2. Create your local settings:

   ```bash
   cp infra/local/.env.example infra/local/.env
   ```

3. Start the local services. The command returns once they're ready, which takes a few minutes the first time:

   ```bash
   docker compose -f infra/local/compose.yaml run --rm start
   ```

4. Install the dependencies and create the database tables:

   ```bash
   npm install
   ```

   ```bash
   npm run db:migrate
   ```

5. Start the API, and keep it running. The first time, it also creates the [demo company](#demo-company) and its sample users:

   ```bash
   npm run start:api
   ```

6. In a second terminal, start the dashboard, and keep it running:

   ```bash
   npm run start:dashboard
   ```

7. Open <http://localhost:4200> and sign in with a sample account. The password for all of them is the value of `KEYCLOAK_DEV_USER_PASSWORD` in `infra/local/.env`, which is `fake-dummy-sample-user-password` unless you changed it.

   | Username | Starts as |
   |---|---|
   | `dev-platform-admin` | Platform Admin, who can create and manage companies |
   | `demo-company-admin`, `demo-tech-lead`, `demo-developer`, `demo-operator`, `demo-viewer` | Members of the [demo company](#demo-company), one in each role |
   | `dev-company-admin` | A user with no company, until invited |
   | `dev-developer` | A user with no company, until invited |

To try the main flow, follow the walkthrough in the [dashboard guide](apps/dashboard/README.md#run-it-locally).

## Demo company

`npm run start:api` creates **Demo Company**, with one sample user in each company role, so you can see what each role can do without inviting anyone. It's set up like any other company, so it gets a Git organization in Forgejo, named `demo-company`, and becomes active a few seconds after the API starts.

To sign in as one of them:

1. Open <http://localhost:4200>. If you're signed in already, choose **Sign out** first.
2. Enter the username from the table below, and the password from `KEYCLOAK_DEV_USER_PASSWORD` in `infra/local/.env`.
3. You land on the overview, which shows **Demo Company** and your role. The menu has only what that role can use.

| Username | Role | What you can try |
|---|---|---|
| `demo-company-admin` | Company Admin | **Team**, to invite people and change roles. **Applications**, to register, change, archive and restore applications. |
| `demo-tech-lead` | Tech Lead | **Applications**, to register, change, archive and restore applications. Also has the permissions for releases, production deployments, migrations, running and testing. |
| `demo-developer` | Developer | **Applications**, to see them. Also has the permissions to push code, build feature images, deploy to test and run tests. |
| `demo-operator` | Operator | **Applications**, to see them. Also has the permissions to deploy to test and production, run migrations and run applications. |
| `demo-viewer` | Viewer | **Applications** and the overview, to see them, without changing anything |

Each user's overview lists everything their role allows under **What you can do**. Features such as releases and deployments aren't built yet, so some permissions have no screen so far. The [Identity and Access guide](apps/api/src/identity-access/README.md#roles) has the full permission table.

To use two of them at once, open the second in a private window, or another browser, because each browser window shares one session.

### See it in Forgejo

Each company is an organization in Forgejo, and each application a repository in it, with the application's type and scaffold as its topics. They're private, so to see them:

1. Open <http://localhost:3000> and choose **Sign in**.
2. Enter `FORGEJO_ADMIN_USERNAME` and `FORGEJO_ADMIN_PASSWORD` from `infra/local/.env`, which are `platform-admin` and `fake-dummy-forgejo-admin-password` unless you changed them.
3. Open <http://localhost:3000/demo-company> for the demo company. An application registered with a scaffold has two commits: Forgejo's first one, and DreamDevOps's, with the scaffold's files.

The demo company is created only when it's missing, so changes you make to it stay. If you close it, it stays closed. If you erase it, it's created again the next time the API starts. To start without it, set `SEED_DEMO_COMPANY=false` in `infra/local/.env`. To create it without restarting the API, run `npm run db:seed`.

## Local services

All of these accept connections only from your own machine.

| Service | Address |
|---|---|
| Dashboard | <http://localhost:4200> |
| API | <http://localhost:4000/api/v1> |
| Keycloak (login) | <http://localhost:8081> |
| Forgejo (Git), with an organization for each company | <http://localhost:3000>, with SSH on port 2222 |
| PostgreSQL | `localhost:5433` |

The services keep running, and restart with Docker, until you stop them:

```bash
docker compose -f infra/local/compose.yaml down
```

## Commands

Run these from the repository root.

| Command | What it does |
|---|---|
| `npm run start:api` | Builds and starts the API |
| `npm run start:dashboard` | Starts the dashboard with live reload |
| `npm run db:migrate` | Applies database migrations |
| `npm run db:seed` | Creates the demo company and its sample users, if they're missing |
| `npm run build` | Builds every package and app |
| `npm run typecheck` | Checks types everywhere |
| `npm test` | Runs the unit and integration tests |
| `npm run test:unit` | Runs only the tests that need no services |
| `npm run test:integration` | Runs only the tests against throwaway containers |
| `npm run test:e2e` | Runs the browser test of the main flow |
| `npm run scaffolds:verify -w @dreamdevops/api` | Fills in every scaffold and runs its type's commands. It needs uv and Python 3.13 too. |

## Configuration

Local settings live in `infra/local/.env`, which Git ignores. [`.env.example`](infra/local/.env.example) lists them all with working values.

When you pull changes, compare the two files and copy any new settings into your `.env`.

The tools keep the passwords they started with, so changing one in `.env` later means changing it inside that tool too. Otherwise, reset the local services with the command below, which **deletes all local data**:

```bash
docker compose -f infra/local/compose.yaml down -v
```

The API reads further settings at startup and refuses to start if a required one is missing or unsafe. The [API guide](apps/api/README.md) describes how it runs.

## Testing

| Level | Needs | Covers |
|---|---|---|
| Unit | Nothing | Domain rules, access checks, API behavior with in-memory fakes, the Forgejo adapter, and dashboard components |
| Integration | Docker | Real PostgreSQL, Keycloak and Forgejo in throwaway containers, including company data separation, provisioning and login |
| Browser | Local services running, and Chrome | Creating a company, managing its team and applications, and suspending and closing it. It starts the API and dashboard itself if needed. |

Integration tests don't touch your local data. The browser tests do: they register new users in your local Keycloak on each run, and add their companies to your local database and their organizations to your local Forgejo.

## Backup and restore

Back up the local data, which covers all databases and Forgejo's files:

```bash
docker compose -f infra/local/compose.yaml run --rm backup
```

Confirm the latest backup can be restored, without touching live data:

```bash
docker compose -f infra/local/compose.yaml run --rm restore-test
```

Restoring replaces live data, so it has its own steps in the [local services guide](infra/local/README.md#backup-and-restore).

## Security

- **Reporting a vulnerability:** don't open a public issue. Contact the repository owner privately.
- **Local credentials:** every password and secret in `.env.example` starts with `fake-dummy-` and is public. Never use these values on a server.
- **Secrets:** never commit real credentials. Git ignores `.env` files, except `.env.example`.
- **Production:** don't expose the local setup to a network. It runs Keycloak in development mode, has sample accounts and open registration, and uses plain HTTP.

The [API guide](apps/api/README.md#security-controls) lists the security controls in place.

## Troubleshooting

| Problem | What to do |
|---|---|
| Compose reports a required variable is missing | Copy `.env.example` to `.env`. If you already have one, copy the new settings into it. |
| A service won't start because a port is in use | Stop whatever uses that port, or change the port in `.env`. |
| The API fails to start | Read its error. It reports any missing or unsafe setting, and the local services must be running. |
| Keycloak rejects the redirect after changing `API_PORT` | The realm accepts logins only from port 4000, so keep that port, or also change `infra/local/keycloak/dreamdevops-realm.json`. |
| After login, the browser can't open `localhost:4200` | Start the dashboard. |
| The API says the demo company wasn't seeded | Keycloak or PostgreSQL wasn't ready when the API started. Start the local services, then run `npm run db:seed`, or restart the API. |
| A demo user sees "You're not in an active company" | The demo company is still being set up, which takes a few seconds after the API starts. Reload the page. |
| The sample accounts don't accept the password | Your Keycloak may have older passwords. Reset the local services as described in [Configuration](#configuration), which deletes local data. |
| Integration tests fail on the first run with an image error | Docker couldn't download a test image. Run them again. |
| The browser test can't launch a browser | Install Google Chrome. |

## Documentation

| Guide | Covers |
|---|---|
| [Local services](infra/local/README.md) | Running, resetting and backing up the local services |
| [API](apps/api/README.md) | Routes, security controls and rules for adding routes |
| [Identity and access](apps/api/src/identity-access/README.md) | Roles, permissions, invitations and their rules |
| [Tenancy](apps/api/src/tenancy/README.md) | Company lifecycle, provisioning company resources, and applications |
| [Application Catalog](apps/api/src/application-catalog/README.md) | Application types, what each needs, and how to add more |
| [Dashboard](apps/dashboard/README.md) | Running, structure and testing of the dashboard |
| [Shared kernel](packages/shared-kernel/README.md) | Company context, domain events, the outbox and background jobs |

## Contributing

Before you open a pull request, check that these all pass:

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run test:e2e
```

New behavior needs tests, and new routes must declare who can call them, as the [API guide](apps/api/README.md#rules-for-module-code) explains.

By contributing, you agree that your contribution is licensed under Apache 2.0.

## License

DreamDevOps is licensed under the [Apache License 2.0](LICENSE).
