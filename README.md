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
| Companies | Creating, renaming, suspending and reactivating companies. Each gets a private Git organization, set up in the background. |
| Users and roles | Invitations, five company roles and a Platform Admin role, with changes applied on the user's next request |
| Company data separation | Enforced in the database with row-level security |
| Audit | A history of every change per company that shows any tampering, and platform admins' own activity |
| Notifications | Emailed invitation links, and company rules that post chosen events to Slack or any webhook |
| Applications | A register of each company's applications, with their type, that can be edited, archived and restored |
| Repositories | Each application gets a private Forgejo repository from its type's blueprint, with Git Flow branches, branch and tag protection, and teams that follow company roles |
| Blueprints | Versioned starting points: a Node.js service and an Angular frontend, each with tests, a Dockerfile and a pipeline |
| Builds and versions | Versioned images: development images of feature pull requests, candidates when a release or hotfix starts, and releases when one is merged into main. Each is validated, scanned, published, signed with cosign's format and verified, and the dashboard shows every step's progress. |
| Environments | Each application's environments, such as staging and production, on the company's hosting targets. Every company starts with **This machine**, the Docker of the machine that runs DreamDevOps, and can plan others: Kubernetes or Docker servers it runs itself, or AWS, Azure or Google Cloud. Switching an environment to another target is one change. Production is protected: only Tech Leads and Operators change it, by typing its name and giving a reason, and it can't be archived. |
| Deployments | Deploying any version that built to an environment on This machine, with every step on the dashboard: checking, verifying the signature, pulling, starting and waiting until it's healthy. A version that isn't healthy is rolled back. Production runs only releases. Moving an environment to another target moves what runs in it. |
| Variables and secrets | Each environment's own settings, which its containers get as environment variables when they start. Secrets are encrypted with a key only the API holds, and never shown again. |
| Editions | Every company on the free Community Edition, with a per-company setting and an extension point for the Commercial Edition |
| Dashboard | Screens for all of the above, in light and dark themes |

Deploying to anything but This machine, setting up cloud infrastructure, and monitoring aren't available yet. Companies can't be deleted.

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| [Node.js](https://nodejs.org) | 24 or later | The API, the dashboard and the tests |
| npm | Included with Node.js | Installing dependencies and running commands |
| [Docker Desktop](https://www.docker.com/products/docker-desktop), or Docker Engine with Compose | Current | The local services, integration tests, and building and scanning images |
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

5. Start the API, and keep it running:

   ```bash
   npm run start:api
   ```

6. In a second terminal, start the dashboard, and keep it running:

   ```bash
   npm run start:dashboard
   ```

7. Open <http://localhost:4200> and sign in with a sample account. The password for all of them is the value of `KEYCLOAK_DEV_USER_PASSWORD` in `infra/local/.env`.

   | Username | Is |
   |---|---|
   | `dev-platform-admin` | Platform Admin, who can start companies |
   | `dev-company-admin` | Company Admin of **Dummy Company** |
   | `dev-tech-lead` | Tech Lead of Dummy Company |
   | `dev-developer` | Developer of Dummy Company |
   | `dev-operator` | Operator of Dummy Company |
   | `dev-viewer` | Viewer of Dummy Company |

   The API sets up Dummy Company, and adds each account to it with its role, every time it starts locally. It adds any account your Keycloak doesn't have yet, with the same password, and leaves alone what exists, such as a role you changed. To skip it, set `SAMPLE_DATA=off` in `infra/local/.env`.

To try the main flow, follow the walkthrough in the [dashboard guide](apps/dashboard/README.md#run-it-locally). Invitation emails don't leave your machine: open them in Mailpit at <http://localhost:8025>.

## Local services

All of these accept connections only from your own machine.

| Service | Address |
|---|---|
| Dashboard | <http://localhost:4200> |
| API | <http://localhost:4000/api/v1> |
| Keycloak (login) | <http://localhost:8081> |
| Forgejo (Git) | <http://localhost:3000>, with SSH on port 2222. Its container registry, at `localhost:3000`, holds built images. |
| Mailpit (caught emails) | <http://localhost:8025> |
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
| `npm run build` | Builds every package and app |
| `npm run typecheck` | Checks types everywhere |
| `npm test` | Runs the unit and integration tests |
| `npm run test:unit` | Runs only the tests that need no services |
| `npm run test:integration` | Runs only the tests against throwaway containers |
| `npm run test:e2e` | Runs the browser test of the main flow |
| `npm run test:scaffolds` | Checks that every blueprint produces a project that builds and runs. Slow, and needs Docker and the internet. |
| `npm run blueprints:publish` | Publishes new blueprint versions. See [Blueprints](blueprints/README.md). |

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
| Unit | Nothing | Domain rules, access checks, API behavior with in-memory fakes, and dashboard components |
| Integration | Docker | Real PostgreSQL and Keycloak in throwaway containers, including company data separation and login |
| Browser | Local services running, and Chrome | The main flow from starting a company to managing its team. It starts the API and dashboard itself if needed. |

Integration tests don't touch your local data. The browser test does: each run registers new users in your local Keycloak, and adds a company to your local database and Forgejo.

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
| The sample accounts don't accept the password | Your Keycloak may have older passwords. Reset the local services as described in [Configuration](#configuration), which deletes local data. |
| The API warns that the sample company couldn't be set up | Read the reason it gives. Keycloak must be running, and `KEYCLOAK_ADMIN_USERNAME` and `KEYCLOAK_ADMIN_PASSWORD` in `.env` must match it. The API works without the sample company. |
| Integration tests fail on the first run with an image error | Docker couldn't download a test image. Run them again. |
| The browser test can't launch a browser | Install Google Chrome. |

## Documentation

| Guide | Covers |
|---|---|
| [Architecture](ARCHITECTURE.md) | The bounded contexts, the rules that keep them apart, and how one becomes a service |
| [Local services](infra/local/README.md) | Running, resetting and backing up the local services |
| [API](apps/api/README.md) | Routes, security controls and rules for adding routes |
| [Identity and access](apps/api/src/identity-access/README.md) | Roles, permissions, invitations and their rules |
| [Tenancy](apps/api/src/tenancy/README.md) | The company lifecycle, and how each company's resources are set up |
| [Audit](apps/api/src/audit/README.md) | The tamper-evident history of changes |
| [Notifications](apps/api/src/notifications/README.md) | Invitation emails, chat rules and webhook safety |
| [Application catalog](apps/api/src/catalog/README.md) | Application types, registering and archiving applications |
| [Blueprints](blueprints/README.md) | What each blueprint sets up, and how to publish a new version |
| [Source governance](apps/api/src/source-governance/README.md) | Repositories, Git Flow rules, teams and Git accounts |
| [Builds and versions](apps/api/src/builds/README.md) | Development, candidate and release images, their versions, validation, scanning and signing |
| [Environments](apps/api/src/environments/README.md) | Environments, hosting targets and providers, deploying, variables and secrets, hosting on this machine, production protection, and adding a provider |
| [Editions and entitlements](apps/api/src/editions/README.md) | Editions, the feature catalog, and how commercial features plug in |
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

New behavior needs tests, and new routes must declare who can call them, as the [API guide](apps/api/README.md#rules-for-module-code) explains. New code follows the [architecture](ARCHITECTURE.md), which `npm test` checks.

By contributing, you agree that your contribution is licensed under Apache 2.0.

## License

DreamDevOps is licensed under the [Apache License 2.0](LICENSE).
