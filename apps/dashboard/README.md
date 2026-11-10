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

Open <http://localhost:4200> and sign in as a demo user. Their password is `KEYCLOAK_DEV_USER_PASSWORD` in `infra/local/.env`.

| Username | Role |
|---|---|
| `demo-platform-admin` | Platform Admin, who manages companies |
| `demo-company-admin` | Company Admin of Demo Company |
| `demo-tech-lead` | Tech Lead of Demo Company |
| `demo-developer` | Developer in Demo Company |
| `demo-operator` | Operator in Demo Company |
| `demo-viewer` | Viewer in Demo Company |
| `dev-platform-admin` | Platform Admin, used by the automated tests |

Platform admins, Company Admins and Tech Leads set up an authenticator app the first time they sign in. The local API creates Demo Company and adds its members when it starts, if they're missing. Sign in as each role to see what it can do.

To see the whole flow:

1. Sign in as `demo-company-admin` to work in Demo Company right away.
2. To see how a company starts, sign in as `demo-platform-admin`, open **Companies**, and enter a company name and a new address such as `someone@example.com`. Then sign out, open the invitation email in [Mailpit](http://localhost:8025), follow its link, register as that person and accept.
3. Open **Applications** to register the company's applications and follow their repositories into Forgejo, **Team** to invite others and manage roles, **Audit log** to see every change, **Notifications** to post events to a chat tool, and **Edition** to see what the company's edition includes. Platform admins set each company's edition under **Editions**. **Blueprints** shows what each application type starts with.
4. To use Git, choose **Sign in to Forgejo** on the **Applications** page, then **Check again** to join your team.
5. Open an application to see its versions and builds, build a feature image from a `feature/*` branch, and start releases and hotfixes. Feature images need the Developer or Tech Lead role, and releases need Tech Lead.
6. Open **Environments** to create test and production environments and connect their targets. This needs the Company Admin or Operator role.

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

`test:e2e` needs the local stack running, and starts the API and dashboard itself. Each run registers new users in your local Keycloak, adds a company to your local database and Forgejo, and sends emails to Mailpit. It reads the invitation links from those emails. They build up until you run `docker compose down -v`.

The dashboard uses TypeScript 6.0, because Angular 22 doesn't support the TypeScript 7 used by the rest of the repository.
