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

## Identity is fake for now

Login goes through `FakeIdentityProvider`, which lets anyone sign in as a sample user. Identity and Access will replace it with Keycloak, behind the same `IdentityProvider` port. Until then, the API refuses to start when `NODE_ENV` is `production`.

Open one of these in a browser to sign in. You land on `/api/v1/auth/me`, which shows who you are:

| User | Company | Permissions |
|---|---|---|
| [tech-lead-a](http://localhost:4000/api/v1/auth/login?as=tech-lead-a) | A | `applications:read`, `applications:write` |
| [developer-a](http://localhost:4000/api/v1/auth/login?as=developer-a) | A | `applications:read` |
| [tech-lead-b](http://localhost:4000/api/v1/auth/login?as=tech-lead-b) | B | `applications:read`, `applications:write` |
| [platform-admin](http://localhost:4000/api/v1/auth/login?as=platform-admin) | None | `companies:manage` |

The permission names are samples. Identity and Access will define the real ones.

## Routes

All routes start with `/api/v1`.

| Route | Access | Purpose |
|---|---|---|
| `GET /auth/login` | Public | Starts login |
| `GET /auth/callback` | Public | Finishes login and creates the session |
| `GET /auth/me` | Signed in | Shows the signed-in user |
| `POST /auth/logout` | Signed in | Ends the session |
| `GET /health/live` | Public | The process is running |
| `GET /health/ready` | Public | The process can reach its database |

## Rules for module code

Every route must declare who can call it, with one of these decorators. A route with none is denied to everyone.

```ts
@Public()                                  // Anyone
@Authenticated()                           // Any signed-in user
@RequirePermissions('applications:write')  // Signed-in users with every listed permission
```

Each request runs in the signed-in user's company, which comes only from the server-side session. Use `TenantDatabase` for company data, and row-level security limits it to that company. If a user with no company calls such a route, the answer is 403.

## Security controls

- **Sessions:** the browser holds a random ID in an `HttpOnly`, `SameSite=Lax` cookie, which is `Secure` unless `SECURE_COOKIES=false`. The database stores only its hash, and the application role can reach sessions only through functions that need that hash.
- **Session limits:** sessions end after 30 minutes idle or 8 hours in total. Login replaces any previous session.
- **Login:** the flow uses `state` and PKCE, and redirects only to the configured dashboard address.
- **Cross-site requests:** state-changing requests from an unknown `Origin` are refused, and no CORS access is granted.
- **Rate limits:** 300 requests a minute per address, and 20 for `/auth` routes. Counts are held in memory, so each API instance counts separately.
- **Errors:** every error uses the `application/problem+json` format and hides internal details.
- **Headers and bodies:** Helmet sets the security headers, and request bodies are limited to 1 MB.

Behind a reverse proxy, set `TRUSTED_PROXIES` to the number of proxies, or every client appears to share one address for rate limits.

## Tests

| Command, from this folder | What it runs |
|---|---|
| `npm run test:unit` | The real application with in-memory fakes, with no Docker |
| `npm run test:integration` | Sessions and company data against a throwaway PostgreSQL, using Docker Desktop |
| `npm test` | Both |
