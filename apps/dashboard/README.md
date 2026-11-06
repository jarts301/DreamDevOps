# Dashboard

The Angular application people use. Feature areas are lazy-loaded and mirror the backend's contexts, and the API checks every request, so nothing in the browser grants access.

## Run it locally

With the [local stack](../../infra/local/README.md) running, run each of these from the repository root, in its own terminal:

```bash
npm run start:api
```

```bash
npm run start:dashboard
```

Open <http://localhost:4200> and sign in as a sample user. Their password is `KEYCLOAK_DEV_USER_PASSWORD` in `infra/local/.env`.

| Sample user | Starts as |
|---|---|
| `dev-platform-admin` | Platform Admin, who manages companies |
| `dev-company-admin` | No company until invited |
| `dev-developer` | No company until invited |

To see the whole flow:

1. Sign in as `dev-platform-admin`, open **Companies**, enter a company name and `dev-company-admin@example.com`, and copy the link. The company shows **Active** once its Git organization is set up.
2. Sign out, open the link, sign in as `dev-company-admin` and accept.
3. Open **Team** to invite others and manage roles.

## Layout

| Folder | Contents |
|---|---|
| `src/app/core` | Session, route guards, error messages and role labels |
| `src/app/shell` | The page frame and navigation. New feature areas add their menu item here. |
| `src/app/features` | One folder per feature area |

## Tests

| Command, from this folder | What it runs |
|---|---|
| `npm test` | Component and service tests, with no servers |
| `npm run test:e2e` | A browser test of the whole flow, using your installed Chrome |

`test:e2e` needs the local stack running, and starts the API and dashboard itself. Each run registers new users in your local Keycloak and adds a company to your local database and Forgejo. They build up until you run `docker compose down -v`.

The dashboard uses TypeScript 6.0, because Angular 22 doesn't support the TypeScript 7 used by the rest of the repository.
