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
| `demo-company-admin`, `demo-tech-lead`, `demo-developer`, `demo-operator`, `demo-viewer` | Members of the demo company, one in each role |
| `dev-company-admin` | No company until invited |
| `dev-developer` | No company until invited |

Their password is `KEYCLOAK_DEV_USER_PASSWORD` in `infra/local/.env`. `npm run start:api` creates the demo company and its members first, with `scripts/seed-local.ts`, unless `SEED_DEMO_COMPANY=false`. It creates any of them Keycloak doesn't have, because Keycloak imports its realm only once. To see how they join a company, read the [Identity and Access guide](src/identity-access/README.md).

The realm only accepts logins from port 4000, so changing `API_PORT` also needs a change in `infra/local/keycloak/dreamdevops-realm.json`.

## Routes

All routes start with `/api/v1`.

| Route | Access | Purpose |
|---|---|---|
| `GET /auth/login` | Public | Starts login |
| `GET /auth/callback` | Public | Finishes login and creates the session |
| `GET /auth/me` | Signed in | Shows the signed-in user |
| `POST /auth/logout` | Signed in | Ends the session |
| Others | | See the [Identity and Access](src/identity-access/README.md), [Tenancy](src/tenancy/README.md) and [Application Catalog](src/application-catalog/README.md) guides |
| `GET /health/live` | Public | The process is running |
| `GET /health/ready` | Public | The process can reach its database |

## Rules for module code

Every route must declare who can call it, with one of these decorators. A route with none is denied to everyone.

```ts
@Public()                                  // Anyone
@Authenticated()                           // Any signed-in user
@RequirePermissions('releases:start')      // Signed-in users with every listed permission
```

Each request runs in the signed-in user's company, which comes only from the server-side session. Use `TenantDatabase` for company data, and row-level security limits it to that company. If a user with no company calls such a route, the answer is 403.

## Background work

Changes that other modules react to are saved as events in the outbox, in the same transaction as the change. The API delivers them while it runs:

1. The outbox relay reads saved events, connecting as `dreamdevops_relay`, the only role that reads across companies.
2. The event bus gives each subscriber its own job, through the pg-boss queue in the `pgboss` schema, which `dreamdevops_jobs` owns.
3. Each job runs in its event's company context, and runs again if it fails.

Tenancy uses this to provision each company's resources, such as its Git organization in Forgejo, and each application's repository, with its scaffold, all through Forgejo's REST API. Several API instances can run together: their relays never take the same events, and because a crash can still deliver an event twice, every handler is safe to run again.

## Settings

`npm run start:api` sets these from `infra/local/.env`. Elsewhere, set them yourself.

| Setting | Purpose |
|---|---|
| `API_DATABASE_URL` | Connects as `dreamdevops_app`, for requests |
| `RELAY_DATABASE_URL` | Connects as `dreamdevops_relay`, for the outbox relay |
| `JOBS_DATABASE_URL` | Connects as `dreamdevops_jobs`, for the job queue |
| `FORGEJO_URL` | Where the API reaches Forgejo. Production requires https. |
| `FORGEJO_USERNAME`, `FORGEJO_PASSWORD` | A Forgejo administrator, which creating organizations needs. Outside your own machine, use an access token as the password. |
| `KEYCLOAK_ISSUER_URL`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` | The login provider |
| `API_PUBLIC_URL`, `DASHBOARD_URL` | Where the browser reaches the API and the dashboard |

## Security controls

- **Sessions:** the browser holds a random ID in an `HttpOnly`, `SameSite=Lax` cookie, which is `Secure` unless `SECURE_COOKIES=false`. The database stores only its hash, and the application role can reach sessions only through functions that need that hash.
- **Session limits:** sessions end after 30 minutes idle or 8 hours in total. Login replaces any previous session, and logout also ends the Keycloak session.
- **Login:** the flow uses `state`, a nonce and PKCE, and redirects only to the configured dashboard address. In production, the API refuses to start without https for Keycloak, secure cookies and verified emails for invitations.
- **Cross-site requests:** state-changing requests from an unknown `Origin` are refused, and no CORS access is granted.
- **Rate limits:** 300 requests a minute per address, and 20 for login and invitation routes. Counts are held in memory, so each API instance counts separately.
- **Errors:** every error uses the `application/problem+json` format and hides internal details.
- **Headers and bodies:** Helmet sets the security headers, and request bodies are limited to 1 MB.

Behind a reverse proxy, set `TRUSTED_PROXIES` to the number of proxies, or every client appears to share one address for rate limits.

## Tests

| Command, from this folder | What it runs |
|---|---|
| `npm run test:unit` | The real application with in-memory fakes, with no Docker |
| `npm run scaffolds:verify` | Fills in every scaffold and runs its type's commands, as the [Application Catalog guide](src/application-catalog/README.md#keeping-scaffolds-working) describes |
| `npm run test:integration` | Access rules, tenancy and background work against a throwaway PostgreSQL, login through a throwaway Keycloak, and Git organizations in a throwaway Forgejo, using Docker Desktop |
| `npm test` | Both |
