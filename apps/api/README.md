# API and backend for frontend

The NestJS application behind the dashboard. It handles login and sessions, decides who can call each route, sets the company for each request, and applies rate limits.

## Run it locally

With the [local stack](../../infra/local/README.md) running, from the repository root:

```bash
npm run db:migrate
```

```bash
npm run start:api
```

The API listens on <http://localhost:4000>, and only accepts connections from your PC.

## Sign in

The API uses the `dreamdevops` realm in the local Keycloak. Open <http://localhost:4000/api/v1/auth/login> and sign in as a sample user, or use **Register** to create a user. You land on the [dashboard](../dashboard/README.md), so start it too. Without it, open `/api/v1/auth/me` to see who you are.

| Sample user | Starts as |
|---|---|
| `dev-platform-admin` | Platform Admin |
| `dev-company-admin` | No company until invited |
| `dev-developer` | No company until invited |

Their password is `KEYCLOAK_DEV_USER_PASSWORD` in `infra/local/.env`. To see how they join a company, read the [Identity and Access guide](src/identity-access/README.md).

The realm only accepts logins from port 4000, so changing `API_PORT` also needs a change in `infra/local/keycloak/dreamdevops-realm.json`.

## Routes

All routes start with `/api/v1`.

| Route | Access | Purpose |
|---|---|---|
| `GET /auth/login` | Public | Starts login |
| `GET /auth/callback` | Public | Finishes login and creates the session |
| `GET /auth/me` | Signed in | Shows the signed-in user |
| `POST /auth/logout` | Signed in | Ends the session |
| Others | | See the [Identity and Access](src/identity-access/README.md), [Tenancy](src/tenancy/README.md), [Audit](src/audit/README.md), [Notifications](src/notifications/README.md), [Editions](src/editions/README.md), [Application Catalog](src/catalog/README.md), [Source Governance](src/source-governance/README.md), [Builds](src/builds/README.md), [Environments](src/environments/README.md), [Monitoring](src/monitoring/README.md) and [Alerts](src/alerts/README.md) guides |
| `GET /health/live` | Public | The process is running |
| `GET /health/ready` | Public | The process can reach its database |

## Rules for module code

Each bounded context is a folder with `domain`, `application`, `infrastructure`, `http` and `messaging` layers, and a Nest module that puts it together. Contexts use each other only through what they publish. The [architecture guide](../../ARCHITECTURE.md) explains the layers and rules, and `test/architecture.test.ts` checks them.

Every route must declare who can call it, with one of these decorators. A route with none is denied to everyone.

```ts
@Public()                                  // Anyone
@Authenticated()                           // Any signed-in user
@RequirePermissions('releases:start')      // Signed-in users with every listed permission
```

Each request runs in the signed-in user's company, which comes only from the server-side session. Use `TenantDatabase` for company data, and row-level security limits it to that company. If a user with no company calls such a route, the answer is 403.

When a rule refuses a request, throw the context's subclass of the shared kernel's `DomainError`, such as `CatalogError`. Its kind, such as `conflict`, decides the status, and its message is shown to the user.

## Security controls

- **Sessions:** the browser holds a random ID in an `HttpOnly`, `SameSite=Lax` cookie, which is `Secure` unless `SECURE_COOKIES=false`. The database stores only its hash, and the application role can reach sessions only through functions that need that hash.
- **Session limits:** sessions end after 30 minutes idle or 8 hours in total. Login replaces any previous session, and logout also ends the Keycloak session.
- **Login:** the flow uses `state`, a nonce and PKCE, and redirects only to the configured dashboard address. In production, the API refuses to start without https for Keycloak, secure cookies and verified emails for invitations.
- **Cross-site requests:** state-changing requests from an unknown `Origin` are refused, and no CORS access is granted.
- **Rate limits:** 300 requests a minute per address, and 20 for login and invitation routes. Counts are held in memory, so each API instance counts separately.
- **Errors:** every error uses the `application/problem+json` format and hides internal details.
- **Headers and bodies:** Helmet sets the security headers, and request bodies are limited to 1 MB.

Behind a reverse proxy, set `TRUSTED_PROXIES` to the number of proxies, or every client appears to share one address for rate limits.

## Background processing

The API also runs the outbox relay and the job queue, which deliver saved events to the modules that react to them: company provisioning, repositories, image builds, deployments, the audit log, chat notifications and alert emails. The job queue also checks alerts every minute, on a schedule all API processes share. Each uses its own database role. They start and stop with the API. Each context sets up what it reacts to in its `messaging` folder.

Each queue's worker takes up to 10 jobs at a time and keeps going while a backlog remains. Each job succeeds or fails on its own, so one failure never repeats the jobs beside it. Builds take minutes, so their worker takes one at a time, with a heartbeat that lets a stopped API's build start again. Deployments work the same way, two at a time.

## Tests

| Command, from this folder | What it runs |
|---|---|
| `npm run test:unit` | The real application with in-memory fakes, the architecture rules, and the Forgejo, registry and Docker adapters against stand-ins, with no Docker |
| `npm run test:integration` | Access rules, company provisioning, image builds and deployments against a throwaway PostgreSQL, plus login through a throwaway Keycloak and organizations in a throwaway Forgejo, using Docker Desktop |
| `npm test` | Both |
| `npm run test:scaffolds` | Every blueprint version, rendered, installed, tested, built and run as a container. Needs Docker and the internet. |
