# Source Governance

Creates each application's repository in its company's Forgejo organization, enforces Git Flow there, and keeps the organization's teams in line with company roles.

## Repositories

Registering an application creates its repository in the background:

1. A private repository named after the application's short name, with the application ID in its description, which proves it's ours.
2. The scaffold from the newest version of the blueprint chosen for the application, such as Vue in TypeScript, as the first commit on `main`.
3. A `develop` branch, which becomes the default branch.
4. Branch and tag protection, below.

Each step is safe to repeat. A failure is retried, and after the last attempt the repository shows as failed with the reason, and Tech Leads and Company Admins can try again. Applications registered before this module need **Create repository** once.

Archiving an application makes its repository read-only in Forgejo, and restoring it undoes that. Nothing is deleted.

## Git Flow rules

Forgejo enforces these on the server, so nobody can get around them from a local Git client.

| Branch or tag | Direct pushes | Merges |
|---|---|---|
| `feature/*` | Allowed | Not protected |
| `develop`, `main` | Nobody | Pull request with one approval from the Tech Leads team |
| `release/*`, `hotfix/*` | Only the platform, which creates them | Pull request with one approval from the Tech Leads team |
| `v*` tags | Only the platform | |

Rejected reviews block a merge, and new commits dismiss earlier approvals.

**Not enforced yet:**
- **Passing tests:** required checks come with the build step, once CI runners exist.
- **Source branch for `main`:** Forgejo can't limit which branch a pull request into `main` comes from. Release Management will only open those from release and hotfix branches.

## Teams

Each organization has three teams, which cover every repository:

| Team | Who | Access |
|---|---|---|
| `tech-leads` | Members whose role can approve pull requests | Write, and approve |
| `developers` | Members whose role can push code | Write |
| `readers` | Everyone else | Read |

Releases, Actions and packages are read-only for every team.

## Git accounts

People sign in to Forgejo with their DreamDevOps account, through Keycloak. Forgejo creates their account on first sign-in, named after their Keycloak user ID, which nobody can choose, so no one can take over another account by name.

The platform can only add someone to a team once their account exists. So after first signing in to Forgejo, people choose **Check again** on the **Applications** page. Role changes, removals and suspensions apply at once, through events. The sync also removes anyone added to a team by hand in Forgejo.

## Routes

All routes start with `/api/v1`.

| Route | Who | Purpose |
|---|---|---|
| `GET /company/repositories` | Any member | The company's repositories, with status, link and blueprint version |
| `POST /company/applications/:id/repository` | `applications:create` | Creates the repository, or tries again after a failure |
| `GET /company/source-access` | Any member | Whether you have a Git account yet, and your team |
| `POST /company/source-access/sync` | Any member | Brings the company's teams in line, then returns your access |
| `GET /blueprints` | Signed in | Every blueprint version |

## Settings

| Setting | Purpose |
|---|---|
| `FORGEJO_PUBLIC_URL` | Forgejo's address in browsers, for links. Defaults to `FORGEJO_URL`. |
| `BLUEPRINTS_DIR` | The blueprints folder. Defaults to the repository's `blueprints` folder. |

## For other modules

Other modules find an application's repository through `RepositoryLookup`, in `application/repository-lookup.ts`, and never read this module's tables. `RepositoryRequested` and `RepositoryCreated` are a contract, typed in `domain/events.ts`, because Builds reacts to `RepositoryCreated`. Change them only compatibly. See the [architecture guide](../../../../ARCHITECTURE.md).
