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
| `dev-platform-admin` | Platform Admin, who can create and manage companies |
| `demo-company-admin`, `demo-tech-lead`, `demo-developer`, `demo-operator`, `demo-viewer` | Members of the demo company, one in each role |
| `dev-company-admin` | No company until invited |
| `dev-developer` | No company until invited |

To see what each role can do, sign in as one of the demo company's members, as the [main README](../../README.md#demo-company) describes.

To see the whole flow:

1. Sign in as `dev-platform-admin`, open **Companies**, and create a company. Its page updates by itself while its Git organization is set up in Forgejo, which takes a few seconds.
2. Once it's **Active**, enter `dev-company-admin@example.com` as the first admin and copy the link.
3. Sign out, open the link, sign in as `dev-company-admin` and accept.
4. Open **Applications** to register the company's applications, each as a TypeScript or Python frontend or backend, started from a scaffold such as Angular or FastAPI. Each gets a repository in Forgejo with the scaffold in it, and the page links to it once it's ready. **See what each application type needs** explains each type. Open **Team** to invite others and manage roles.
5. Back as `dev-platform-admin`, the company's page can rename, suspend, reactivate and close it. Suspending takes its members' access away until it's reactivated. Once it's closed, **Erase company data** replaces everything that identifies it.

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
| `npm run test:e2e` | Browser tests of the main flows, using your installed Chrome |

`test:e2e` needs the local stack running, and starts the API and dashboard itself. It registers new users and creates companies each run, so they build up in your local Keycloak, database and Forgejo until you run `docker compose down -v`.

The dashboard uses TypeScript 6.0, because Angular 22 doesn't support the TypeScript 7 used by the rest of the repository.
