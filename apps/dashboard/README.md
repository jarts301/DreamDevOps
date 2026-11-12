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
| `dev-company-admin` | Company Admin of Dummy Company |
| `dev-tech-lead` | Tech Lead of Dummy Company |
| `dev-developer` | Developer of Dummy Company |
| `dev-operator` | Operator of Dummy Company |
| `dev-viewer` | Viewer of Dummy Company |

To try a role, sign in as its account: Dummy Company is ready when the API starts. To see the whole flow, from starting a company to accepting an invitation, use a new company and a new account you register:

1. Sign in as `dev-platform-admin`, open **Companies**, and enter a company name and the email of an account you'll register. The company shows **Active** once its Git organization is set up.
2. Sign out, open the invitation email in [Mailpit](http://localhost:8025), follow its link, register with that email, and accept.
3. Open **Applications** to register the company's applications and follow their repositories into Forgejo, **Team** to invite others and manage roles, **Audit log** to see every change, **Notifications** to post events to a chat tool, and **Edition** to see what the company's edition includes. Platform admins set each company's edition under **Editions**. **Blueprints** shows what each application type starts with.
4. To use Git, choose **Sign in to Forgejo** on the **Applications** page, then **Check again** to join your team.
5. Open **Builds** to follow each application's images. As a Tech Lead, start a release, and watch its first candidate go through validation, building, scanning, publishing, signing and verification. Open a pull request from a `feature/*` branch into `develop` in Forgejo to build a development image of it, and merge the release branch into `main` to build, sign and tag the release.
6. Open **Environments** to give each application its environments. They run on **This machine** unless you choose another target, which you can connect on **Hosting**. As a Tech Lead or Operator, mark one as production, and notice that changing it afterwards asks for its name and a reason.
7. Choose **Deploy** on an environment, pick a version that built, and follow its steps: checking, verifying the signature, pulling, starting and waiting until it's healthy. Open its address once it runs. Production offers only releases, and asks for its name first. This needs Docker, as builds do.
8. Open **Variables** on an environment to give it settings, such as `LOG_LEVEL`, and secrets, such as `DATABASE_URL`. The environment then shows that what runs has older settings, and **Apply now** starts it again with them.
9. Open **Monitoring** to see how what runs is doing: each environment's CPU, memory, requests, response times and server errors. Choose **Show details** to follow one over time, read its logs, and open the traces of its requests. An application registered after the blueprints reached version 1.3.0 sends them on its own, a few seconds after it starts. Open a backend's `/api/ping` to log a line and record a trace, or choose **Check the API** on a frontend's page.
10. Open **Alerts** to get an email when a metric of an environment crosses a threshold for long enough, such as CPU above 80% for 5 minutes. As a Company Admin, Tech Lead or Operator, create one, choosing which members to email, or follow **Set up an alert** from an environment's details on **Monitoring**. Choose **Test email**, and open [Mailpit](http://localhost:8025) to see it. Alerts are checked every minute: when one fires, and when it's resolved, its members get an email, and its **History** shows it. Someone removed on **Team** is taken off every alert, and never emailed.

## Layout

| Folder | Contents |
|---|---|
| `src/app/core` | Session, route guards, error messages, role labels, and `PageActivity`, which every page runs its actions through |
| `src/app/shell` | The page frame and navigation. New feature areas add their menu item here. |
| `src/app/features` | One folder per feature area |
| `src/app/shared` | Components several feature areas use, such as the steps of a build or a deployment |

## Tests

| Command, from this folder | What it runs |
|---|---|
| `npm test` | Component and service tests, with no servers |
| `npm run test:e2e` | A browser test of the whole flow, using your installed Chrome |

`test:e2e` needs the local stack running, and starts the API and dashboard itself. Each run registers new users in your local Keycloak, adds a company to your local database and Forgejo, and sends emails to Mailpit. It reads the invitation links from those emails. They build up until you run `docker compose down -v`.

The dashboard uses TypeScript 6.0, because Angular 22 doesn't support the TypeScript 7 used by the rest of the repository.
