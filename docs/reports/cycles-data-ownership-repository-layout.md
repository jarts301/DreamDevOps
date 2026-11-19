# Report: breaking the cycles, data ownership and repository layout

**Status:** analysis and proposal. Nothing in this report is implemented yet.
**Written:** November 2026, after the work on explicit contracts and the layers inside each context.
**Read first:** [ARCHITECTURE.md](../../ARCHITECTURE.md), which describes the contexts and the rules the architecture test checks today.

The review of the code proposed a path in steps, so the API can be split into parts as it grows. The first steps are done: a safety net of tests, CI and lint; the bug fixes; explicit contracts between contexts, in `packages/contracts`; and the same layers inside every context, with a store behind a port for each context's data. Three steps remain, and this report looks at each of them:

1. [Break the cycles](#1-break-the-cycles): the one cycle of calls left between contexts, and the platform code that still reaches into a context.
2. [Data ownership](#2-data-ownership): the places where one context's data is still tied to another's in the database, or in tools outside it.
3. [Repository layout](#3-repository-layout): how the repository could be arranged so each part can be worked on, tested and, one day, deployed on its own.

For each, the report says where things stand, with the files involved, the options, the one it recommends, the steps to get there, and how to check each step. [A possible order](#4-a-possible-order) puts the three together, and [readiness by context](#5-readiness-by-context) says what stands between each context and a service of its own.

None of this is urgent. The architecture test already keeps new couplings out, and its lists of exceptions can only shrink. The steps here are for when a part of the system needs to move, scale or be owned by a team of its own.

## Contents

- [1. Break the cycles](#1-break-the-cycles)
- [2. Data ownership](#2-data-ownership)
- [3. Repository layout](#3-repository-layout)
- [4. A possible order](#4-a-possible-order)
- [5. Readiness by context](#5-readiness-by-context)
- [6. When to split, and what first](#6-when-to-split-and-what-first)
- [7. Open questions](#7-open-questions)

---

## 1. Break the cycles

### Where things stand

Contexts call each other only through the services in their contracts, injected by tokens. The architecture test builds the graph of these calls from each context's Nest module and fails on any cycle, except one it knows, in `callCycles` in `apps/api/test/architecture.test.ts`:

```text
Identity and access ──INVITATION_MAILER──▶ Notifications
Notifications ──COMPANY_DIRECTORY──▶ Tenancy
Tenancy ──FIRST_ADMIN_INVITATIONS──▶ Identity and access
(Tenancy also calls Notifications, through INVITATION_MAILER)
```

| Edge | Why it exists | Where |
|---|---|---|
| Identity and access calls Notifications | Invitation emails carry the one-time link, so they're sent when the invitation is made | `identity-access/application/company-access.service.ts`, `notifications/application/invitation-emails.ts` |
| Notifications calls Tenancy | Chat messages start with the company's name | `notifications/application/notification-rules.ts`, `#companyName()` |
| Tenancy calls Identity and access | A new company's first admin is invited when the company is made, and the platform admin gets the link in the answer | `tenancy/application/companies.service.ts`, `create` and `inviteFirstAdmin` |

The three can't start, run or be tested apart, and none of them could become a service without the other two. Nest only works with it because Tenancy's `CompanyDirectory` has a module of its own, `tenancy/company-directory.module.ts`, which Notifications imports instead of the whole of Tenancy.

Beside the cycle, some platform code still reaches into contexts. These don't make cycles between contexts, but each is a thread that has to be cut before the context it touches can move:

| Coupling | Where | Why it matters |
|---|---|---|
| The guards use Identity and access | `http/guards.ts` uses Identity's `SESSION_STORE` and `USER_DIRECTORY`, and `hasPermissions`, `requiresMfa` and `toPrincipal` from its domain. It's the `platformIntoContexts` exception in the architecture test. | Every request depends on Identity's code, so Identity can't move without the platform |
| Sessions sit between the platform and Identity | The `api.sessions` table and `session/` are platform code, and Identity's module provides the store, from `session/postgres-session-store.ts` | It's unclear who owns a login session |
| The demo uses contexts' own classes | `demo/` imports `CompaniesService`, `CompanyAccessService`, `ApplicationCatalog`, `Environments` and Identity's domain, not their contracts | The demo is one more place that would break when a context moves |
| Raw database pool in three contexts | Identity and access, Tenancy's company directory and Audit inject `DATABASE_POOL` for reads with no company context, beside their stores | Some of their SQL sits outside their store's transactions |
| One settings object | `config/app-config.ts` holds about 70 settings for every context | A context can't be configured, or started, on its own |

### Options for the cycle

Any one edge removed breaks the cycle. Each edge was looked at:

| Edge to remove | How | For | Against |
|---|---|---|---|
| **Notifications calls Tenancy** | Notifications keeps each company's name itself, from Tenancy's `CompanyCreated` and `CompanyRenamed` events, in a small table of its own | Smallest change. Notifications already hears events. A chat message can't fail because Tenancy is down. | A rename reaches chat messages a few seconds late. Companies made before the change need their names filled in once. |
| Identity and access calls Notifications | Identity publishes `UserInvited` and Notifications sends the email when it hears it | Invitations no longer need Notifications running | The email carries the one-time token. Events are kept in the outbox, and for good in the audit log, so the token can never be put in an event. This would need a second, secret channel. **Not recommended.** |
| Tenancy calls Identity and access | Identity invites the first admin when it hears `CompanyCreated`, with the admin's email in the event | Tenancy no longer depends on Identity | The platform admin no longer gets the link in the answer, only by email, and the demo relies on the link. An email address would go into an event, and so into the audit log for good. |

### Recommendation

Remove **Notifications → Tenancy**. It's the only edge whose call is for display, not for the work itself, and the only one that can move to events without sending a secret or personal data through them.

Steps, each one shippable on its own:

1. **A company-names projection in Notifications.** Add `notification.companies (company_id, name)`, in a migration of its own, and have `NotificationsSubscriptions` keep it from `CompanyCreated` and `CompanyRenamed`, idempotently, as an upsert. Fill it once from Tenancy, for companies made before, with a one-off job that asks `COMPANY_DIRECTORY`. The job runs once, with `deterministicJobId`, like the policy upgrade does.
2. **Read the name from the projection.** `NotificationRules.#companyName()` reads its own table through its store. Notifications' module stops importing `CompanyDirectoryModule`.
3. **Tighten the test.** Remove the entry from `callCycles`. The test then fails if any cycle comes back.

How to check:
- The architecture test passes with `callCycles` empty.
- A notifications test checks a rename reaches the next chat message.
- An integration test checks that a company made before the change is named in a chat message after the one-off job.

Effort: small, about two to three days with tests.

### Recommendations for the platform couplings

| Coupling | Proposal | Effort |
|---|---|---|
| Guards and Identity and access | Move `hasPermissions` and `requiresMfa`, which are pure, into `contracts/identity-access/access.ts` beside `Principal`. Give Identity a published `Authenticator` service, `AUTHENTICATOR.resolve(sessionId) → Principal \| null`, that does what `SessionGuard` does now. The guards then depend only on contracts, and the `platformIntoContexts` exception goes. | Medium |
| Sessions | Decide that login sessions are Identity's: move `session/` into `identity-access/infrastructure`, and the `api.sessions` table into the `identity` schema with a migration. If the dashboard's backend later becomes its own part, the sessions go with it, as the API's front door. | Small |
| The demo | Have `demo/` use only published services, adding those it lacks, such as creating an application for someone, or call the API's own routes as a client would. Once a context is a service, the demo becomes a script against the HTTP API. | Medium |
| Raw pool | Add a session with no company to the shared kernel's `transactional`, for reads across companies, such as a webhook's owner or one person's activity across companies. Contexts then inject only their store. | Small |
| One settings object | Give each context a settings section, read and checked by the context's own `settings.ts`. `loadConfig` puts the sections together and stays the single place that refuses to start. | Medium |

---

## 2. Data ownership

### Where things stand

Each context reaches its data only through its store, and the architecture test checks that each context's SQL names only its own schemas. The database itself still ties the schemas together in four ways. The architecture test lists each migration that does it, in `crossSchemaMigrations`.

#### Foreign keys between schemas

Counted from the migrations, up to `0029`:

| Table's context | References |
|---|---|
| Tenancy | `identity.users`, who made the company |
| Identity and access | `tenancy.companies`, from memberships and invitations. Added by Tenancy's migration `0004`. |
| Audit | `tenancy.companies` |
| Notifications | `tenancy.companies`, `identity.users` |
| Editions | `tenancy.companies`, `identity.users` |
| Catalog | `tenancy.companies`, `identity.users` |
| Source governance | `tenancy.companies`, `catalog.applications` |
| Webhooks | `tenancy.companies`, `catalog.applications` |
| Builds | `tenancy.companies`, `catalog.applications`, `identity.users` |
| Releases | `tenancy.companies`, `catalog.applications`, `identity.users` |
| Environments | `tenancy.companies`, `catalog.applications`, `identity.users` |
| Deployments | `tenancy.companies`, `catalog.applications`, `identity.users`, `builds.builds`, `environments.environments` |
| Alerts | None |

So `tenancy.companies` is referenced by 11 contexts, `identity.users` by 8 and `catalog.applications` by 6.

#### Database functions that read another schema

| Function | Reads | What for | Used by |
|---|---|---|---|
| `identity.user_access` | `tenancy.companies` | Company names, and leaving out suspended companies, in each person's access | Identity's user directory, on every request |
| `identity.invitation_company` | `tenancy.companies` | Refusing invitations to suspended companies | Identity's membership store |
| `audit.company_entries` | `identity.users` | Who made each change, by name | Audit's store |
| `catalog.applications_view` | `identity.users` | Who registered each application | Catalog's store |
| `deployments.deployments_view` | `identity.users` | Who asked for and approved each deployment | Deployments' store |
| `source.member_accounts` | `identity`, `tenancy` | Each member's Forgejo account and role, to keep teams in step | Source governance's store |
| `webhooks.repository_owner` | `source.repositories` | Which application and company a repository belongs to, for a webhook that arrives with no company | The webhook gateway |

#### Migrations that change another context's schema

| Migration | Owner | What it does elsewhere |
|---|---|---|
| `0004` | Tenancy | Adds foreign keys to `identity.memberships` and `identity.invitations`, and rewrites `identity.user_access` and `identity.invitation_company` |
| `0006`, `0008`, `0017`, `0022`, `0024` | Notifications, Editions, Deployments, Alerts | Add their permissions to `identity.role_permissions`, Identity's table |
| `0011` | Webhooks | Adds `policy_version` to `source.repositories` |
| `0017` | Deployments | Creates `environments.variables` and `environments.secrets`, which Environments now owns |

#### Shared parts that aren't a context's

| Part | Who uses it | Note |
|---|---|---|
| `kernel.outbox` and `kernel.current_company_id()` | Every context | One outbox, one relay |
| The `pgboss` schema | Every context | The event bus: topics, queues, subscriptions and schedules |
| The `dreamdevops_app` role | Every context | One role can read and write every schema. Only the architecture test, which reads the SQL as text, keeps contexts to their own. |

#### Resources in tools outside the database

| Tool | What's kept there, and whose it is |
|---|---|
| Forgejo | Each company's organization and teams (Tenancy and Source governance), repositories (Source governance), the pipeline repository and the image registry (Builds), environment repositories (Environments). One bot account, with one password, does all of it. |
| Keycloak | Users and logins (Identity and access) |
| OpenBao | Environments' secrets (Environments) |
| Prometheus, Loki, Jaeger | Telemetry (Monitoring) |

### Why it matters

A context can have its own database only when none of its tables is tied to another's, and nothing outside it reads its tables. Until then, moving one context's data means moving others' too. The shared role also means a bug, or a careless query, in one context can read every other context's data. Only row-level security by company limits it.

### Options

**For foreign keys.** Contexts already treat the IDs as references: they ask each other through contracts, and never join across schemas in their code. Companies, users and applications are never deleted, only suspended or archived, so no cascade depends on these keys. The options are:

- Drop them all at once.
- Drop them context by context, when each one moves.
- Keep them while everything shares one database.

Keeping them costs nothing today, and protects against a bug that writes a wrong ID.

**For names shown beside IDs**, as in the Audit, Catalog and Deployments views:

| Option | How | For | Against |
|---|---|---|---|
| Ask when reading | The store returns IDs, and the use case asks Identity for names through `COMPANY_MEMBERS`, or a new `UserDirectory.names(ids)`, in one call per page | Always current | A call on every page. Former members have no name, unless Identity keeps them. |
| A projection | Each context keeps `(user_id, display_name)`, fed by Identity's events | No call when reading | Identity has no event when someone's name changes, so one would be needed, such as `UserProfileChanged`, sent by `record_login` when the name changes |
| A snapshot when writing | Store the name with the row or entry when it's written | Simple. Right for history, where the name then was what counts. | Names don't follow a rename |

**For permissions**, every context declares the permissions it checks, and only Identity's table holds them. The options:

- Let each context publish its permissions and the roles that get them by default, in a `permissions.ts` in its contracts, and have Identity add any that are missing when it starts.
- Keep seeding them in migrations, but only in Identity's, which reads the list from the contracts.

**For the webhook owner**, Webhooks needs to find a repository's application and company with no company context, and fast, since Forgejo waits for the answer:

- Keep a projection in Webhooks, fed by `RepositoryCreated`.
- Or call a new published `RepositoryDirectory.ownerOf(organization, name)`.

**For the shared role:**

- Give each context a role of its own, such as `dreamdevops_catalog`, with rights on its own schema only. The API's role is a member of them all, and each store starts its transaction with `SET LOCAL ROLE dreamdevops_catalog`. That takes one line in the shared kernel's `TenantDatabase`, and needs no more connections.
- Or give each context a pool of its own, with its own login. That needs many more connections.

### Recommendation

Make the database enforce what the architecture test checks, then remove the couplings context by context, each when it moves, in this order:

1. **A database role per context, with `SET LOCAL ROLE`.** One migration creates the roles and moves each schema's grants to its own role. Each context's store factory passes its role to `transactional`. A query that strays into another schema then fails in tests, not only when the architecture test reads it. The cross-schema functions keep working, because they run as the owner, `SECURITY DEFINER`, and each is granted to the role that uses it. Effort: medium, mostly the grants, with an integration test per context that tries another schema and is refused.
2. **Stop migrations touching other schemas.** Add a rule to the architecture test for migrations after `0029`: a migration may change only its own schema. Permissions move to a list in the contracts, which Identity adds at startup, and later migrations stop inserting into `identity.role_permissions`. Existing migrations stay as they are, since applied migrations never change. Effort: small.
3. **Replace the cross-schema functions**, one at a time, each with a test that the page or the job still shows the same thing:

   | Function | Replacement |
   |---|---|
   | `webhooks.repository_owner` | A `webhooks.repositories` projection, fed by `RepositoryCreated`, plus a one-off fill |
   | `source.member_accounts` | `COMPANY_MEMBERS`, which Source governance can already call, plus each member's Forgejo username, which it keeps itself |
   | `catalog.applications_view`, `deployments.deployments_view` | Names asked from Identity, in one call per page |
   | `audit.company_entries` | The actor's name kept with the entry when it's written, since the history should show who did it then. Former members keep their names. |
   | `identity.user_access`, `identity.invitation_company` | An `identity.companies (company_id, name, suspended)` projection, fed by Tenancy's company events. Suspension then takes effect within seconds, not on the very next request, which is acceptable, but must be stated. |

4. **Drop the foreign keys** of a context when it moves to a database of its own, in that context's first migration there. Each context's code must already cope with an ID it doesn't recognize, such as an application another context hasn't heard of yet, and a test per context should show it.
5. **One outbox per context.** Make the kernel's outbox migration create the outbox in a given schema, so each context has `<schema>.outbox`, and give the relay a list of outboxes. The job queue stays shared: it's the event bus, and a service in another database reaches it the way a broker would be reached. Moving to a real broker later means implementing `JobQueue`'s `publish` and `subscribe` with it, as ARCHITECTURE.md says.
6. **Outside tools.** Give each context its own Forgejo token, with only the scopes it needs, instead of one bot password. The pipeline repository and the registry are Builds', and the organization is Tenancy's. Record the owner of each resource in the contexts' guides.

How to check: the `crossSchemaMigrations` list in the architecture test shrinks with each step, and is empty when every context can move. A new test per context, run as its own role, shows it can't read another schema.

Risks:
- A projection is eventually consistent. Each one needs a one-off fill for data made before it, and a way to rebuild it from the owner: a job that asks the owner again.
- Moving grants to per-context roles can break a query that the architecture test's text search missed, such as SQL built from parts. The integration tests run every store, so they find these, but the change should go in on its own.

---

## 3. Repository layout

### Where things stand

```text
apps/
  api/            every context, the platform code around them, 46 test files and 29 migrations
  dashboard/      Angular, with a feature folder per context
  agent/          the deployment agent
packages/
  contracts/      what each context publishes
  shared-kernel/  company context, events, outbox, jobs, stores
blueprints/       the scaffolds, Blueprints' data
pipelines/        the image pipeline, Builds' data
charts/           the agent's Helm chart
infra/local/      the local stack
```

The repository is an npm workspaces monorepo, on TypeScript 7, with CI on GitHub Actions. The contexts are folders in `apps/api/src`, and the architecture test keeps them apart. Their sizes, in lines of TypeScript:

| Context | Lines | Context | Lines |
|---|---|---|---|
| Environments | 3,267 | Notifications | 951 |
| Builds | 2,926 | Releases | 909 |
| Deployments | 2,671 | Tenancy | 899 |
| Alerts | 1,604 | Catalog | 641 |
| Monitoring | 1,495 | Audit | 490 |
| Source governance | 1,355 | Blueprints | 417 |
| Identity and access | 1,239 | Editions | 363 |
| | | Webhooks | 319 |

What works well today:
- One install, one lockfile, and one typecheck.
- A change across contexts and contracts is one pull request.
- The architecture test stops imports that cross the boundaries.

What's harder as the project grows:
- The boundaries are kept by a test that reads imports as text, not by the package manager or the compiler.
- Every change runs every test, so CI takes as long for a one-line change in one context as for a change to all of them.
- Contexts' tests, migrations and fakes sit together in `apps/api`, so a context's whole footprint is spread over several folders.
- Contexts import platform files by relative path, such as `../platform/module-settings.ts`, `../http/access.decorators.ts`, `../tokens.ts` and `../shared/forgejo/forgejo-api.ts`. Those files would have to come along with any context that moves.
- Nothing says who owns what.

### Options

| Option | What it is | For | Against |
|---|---|---|---|
| A. Folders, as now | Keep the contexts in `apps/api/src`, and add ownership and per-context test and migration folders | No churn. The architecture test already does the checking. | Boundaries stay a test's business. CI doesn't get faster. |
| B. A package per context, in the monorepo | `contexts/<name>/` as npm workspace packages, each with its code, migrations, tests and guide. `apps/api` only puts them together. | The compiler and the package manager keep the boundaries: a context can only import what its `package.json` declares. Each context is tested and built alone, and moves to a service with its folder. | More `package.json` and `tsconfig` files, and a build order to keep. Shared Nest helpers must become a package first. |
| C. A repository per service | Split repositories, with contracts published as a versioned package | Independent teams and releases | Changes across contracts become releases and upgrades. Only worth it once contexts are services run by separate teams. |

### Recommendation

Move from A to B in small steps, and leave C until a context is a service with a team of its own. Each step is useful on its own, so the work can stop after any of them.

1. **Ownership, and per-context test folders.** Add a `CODEOWNERS` file, with a line per context folder, including its contracts, its migrations, and `blueprints/` and `pipelines/`. Move `apps/api/test/*` into `apps/api/test/<context>/` for context tests and `apps/api/test/platform/` for the rest, with the shared fakes in `test/fakes/`, as now. Effort: small.
2. **Migrations beside their context.** Move each context's migrations into `apps/api/src/<context>/migrations/`, with their names unchanged, so the database's record of applied migrations, in `api_migrations`, stays valid. `migrate.ts` passes the list of folders to node-pg-migrate, whose `dir` takes several. Before moving them, check that node-pg-migrate orders migrations by name across folders. The numbers stay global, so their order stays the same. The architecture test's `MIGRATION_OWNERS` is then replaced by where each file is. Effort: small, plus a test that a database migrated before the move sees nothing new to apply.
3. **Platform helpers as packages.** Move what contexts import from the platform into packages they can depend on:
   - `@dreamdevops/nest-platform`: `platform/module-settings.ts`, `http/access.decorators.ts`, `background/background-subscriber.ts`, and the `APP_CONFIG` and `DATABASE_POOL` tokens.
   - `@dreamdevops/forgejo-client`: `shared/forgejo`.
   - The pure helpers in `shared/`, `slug`, `names` and `sealed-box`, to the shared kernel. `run-command` goes to `nest-platform`, or to the contexts that use it.

   Effort: medium.
4. **A first context as a package.** Pick a small one with few callers, such as Webhooks, Editions or Catalog, and move it to `contexts/<name>/`:
   - The package is `@dreamdevops/<name>`, and exports only its Nest module, and its fakes from a `testing` entry point.
   - Its `package.json` lists what it may use: the contracts, the shared kernel and `nest-platform`, never another context.
   - `apps/api` depends on it and imports its module.
   - The architecture test reads contexts from both places during the move, and its layer rules apply to each package.
   - TypeScript project references, `tsc -b`, build the packages in order, and the `@dreamdevops/source` export condition keeps tests and the dashboard on source, as today.

   Effort: medium for the first one, then small for each one after.
5. **The rest, one by one.** Do the hub contexts, Tenancy and Identity and access, after the cycle is broken. When every context is a package, `apps/api` holds only the composition root, `http/`, `background/`, `config/`, `health/`, `database/` and the demo.
6. **CI by what changed.** Once contexts are packages, run each package's tests only when it, or something it depends on, changed. npm workspaces can do it with a small script. Turborepo or Nx can do it with caching too, and are only worth adding if CI time becomes a problem. The full suite still runs on `main`.

Proposed layout at the end of step 5:

```text
apps/
  api/               composition root, guards, background processing, settings, health, demo
  dashboard/
  agent/
contexts/
  catalog/           package.json, src/{domain,application,infrastructure,http,messaging}, migrations/, test/, README.md
  builds/            the same, with pipelines/ beside it
  blueprints/        the same, with the blueprint library beside it, or blueprints/ kept at the root as its data
  ...
packages/
  contracts/
  shared-kernel/
  nest-platform/
  forgejo-client/
infra/, charts/
```

The dashboard can stay as it is: its feature folders already follow the contexts, and it reads only the contracts. If separate teams own screens later, each feature folder can become an Angular library the same way.

How to check each step:
- `npm run typecheck`, `npm test` and the architecture test pass.
- A context package's `package.json` names no other context.
- A new test checks that no package imports a file outside its own folder by relative path.

Risks:
- **Decorators across packages.** NestJS's `experimentalDecorators` must be on in every context package, which `tsconfig.base.json` can set.
- **The dashboard's build.** The `@dreamdevops/source` condition must keep working for the dashboard's build, which the move doesn't touch, but a test of it would catch it.
- **Coverage thresholds** are set for `apps/api` today. Each package needs its own, starting from what its tests cover when it moves.

---

## 4. A possible order

The three topics support each other. This order keeps every step small, and leaves the system working after each:

| Step | Topic | Why then | Size |
|---|---|---|---|
| 1 | Break the cycle: Notifications keeps company names | Unblocks three contexts at once, and it's small | S |
| 2 | Ownership and per-context test folders | Shows who owns what before anything moves | S |
| 3 | A database role per context | The database enforces the boundaries the test checks, before anything moves | M |
| 4 | Migrations beside their context, and the rule against touching other schemas | Every later change lands in the right place | S |
| 5 | Guards through an `Authenticator` contract, sessions in Identity, a session with no company in the kernel | Removes the last platform exceptions | M |
| 6 | Platform helpers as packages | Needed before a context can leave `apps/api` | M |
| 7 | Settings per context | Needed before a context can start on its own | M |
| 8 | A first context as a package | Proves the layout with little risk | M |
| 9 | Replace the cross-schema functions | One at a time, each with its own test | M each |
| 10 | The other contexts as packages | One at a time | S each |
| 11 | An outbox per context, then foreign keys dropped per context | Only when a context moves to a database of its own | M per context |

Steps 1 to 5 are worth doing even if nothing is ever split, as they make the boundaries stronger. Steps 6 onwards are for when the project needs to split, or separate teams need to own parts of it.

## 5. Readiness by context

What stands between each context and a service of its own. "Calls" and "Called by" are the published services used, from the Nest modules.

| Context | Calls | Called by | Blockers in the database | Other blockers | Readiness |
|---|---|---|---|---|---|
| Monitoring | Catalog, Deployments, Environments | Alerts | None: no schema | Its settings are in the shared object | **Easiest** |
| Alerts | Catalog, Environments, Identity, Monitoring, Notifications, Tenancy | Nobody | Seeds a permission in Identity's table | Calls six contexts | Easy |
| Webhooks | Nobody | Nobody | Keys to `tenancy` and `catalog`; `repository_owner` reads `source` | A webhook arrives with no company, so finding its owner needs a lookup across companies | Easy, after the projection |
| Editions | Tenancy | Deployments | Keys to `tenancy` and `identity`; seeds a permission | Its feature guard is used by the whole API | Easy |
| Audit | Tenancy | Nobody | Key to `tenancy`; `company_entries` reads `identity` | Hears every event; raw pool | Medium |
| Notifications | Tenancy | Identity, Tenancy, Alerts | Keys to `tenancy` and `identity`; seeds a permission | In the cycle | Medium, easy after step 1 |
| Blueprints | Nobody | Catalog, Source governance, Deployments | None: files | The `blueprints/` folder and publishing script | Medium: it's a library more than a service |
| Catalog | Blueprints | Seven contexts | Keys to `tenancy` and `identity`; six contexts key to it; `applications_view` reads `identity` | Widely called | Medium |
| Releases | Builds, Catalog, Source governance | Nobody | Keys to `tenancy`, `catalog` and `identity` | None | Medium |
| Source governance | Blueprints, Catalog, Tenancy | Builds, Releases, Deployments | Keys to `tenancy` and `catalog`; `member_accounts` reads `identity` and `tenancy`; Webhooks reads its table | Shares the Forgejo bot | Medium |
| Builds | Catalog, Source governance | Releases, Deployments, Environments | Keys to `tenancy`, `catalog` and `identity`; Deployments keys to it | `pipelines/` folder; shares the Forgejo bot and registry | Medium |
| Environments | Builds, Catalog, Tenancy | Deployments, Monitoring, Alerts | Keys to `tenancy`, `catalog` and `identity`; Deployments keys to it; its variables' tables were made by a Deployments migration | OpenBao; the agent protocol | Hard: the largest context |
| Deployments | Blueprints, Builds, Catalog, Editions, Environments, Source governance | Monitoring | Keys to five schemas; `deployments_view` reads `identity`; seeds permissions | Calls six contexts; This machine's Docker | Hard |
| Tenancy | Identity, Notifications | Six contexts | Referenced by 11 schemas; keys to `identity`; changes Identity's tables in `0004` | In the cycle; raw pool | Hard: a hub |
| Identity and access | Notifications | Tenancy, Alerts, the guards, the demo | Referenced by 8 schemas; its functions read `tenancy`; holds every context's permissions | In the cycle; the guards; sessions; Keycloak | Hardest: every request uses it |

## 6. When to split, and what first

Splitting has costs: calls over the network, which fail in new ways, more to deploy and watch, and data that's only eventually the same in each service. It's worth it when one of these holds:

- **A part needs to scale on its own.** Monitoring's telemetry gateway takes every target's metrics, logs and traces, and will grow with the number of environments, not with the number of people using the dashboard.
- **A part must stay up when others are down.** The webhook gateway should accept Forgejo's events even while the rest of the API is being deployed.
- **A team needs its own pace.** A team that owns builds and releases, for example, and deploys them daily.
- **A part has different security needs.** For example, the agent-facing routes of Environments, which targets on other networks call.

By those, the first candidates are **Monitoring**, which is already free of the database, then the **webhook gateway**, once its projection is in place. Identity and access and Tenancy should be the last, and may well stay together in the API, which then acts as the dashboard's backend: it keeps the login session and calls the services with a signed token that says who the user is and which company they're acting for.

## 7. Open questions

- **Suspension:** is a suspension that takes effect within seconds, through a projection, acceptable to the business, or must it stay immediate? If immediate, Identity would keep calling Tenancy, which doesn't make a cycle once Notifications no longer calls Tenancy.
- **Former members:** should their names show in history after they leave? Today the audit log shows the current name of anyone still in `identity.users`.
- **Permission removals:** when a context drops a permission, should Identity remove it at startup, or keep it until a person removes it? Removing it on its own changes what roles can do without anyone deciding it.
- **Tooling:** npm workspaces with TypeScript project references, or a build tool such as Turborepo or Nx? The answer depends on how long CI takes once contexts are packages.
- **Blueprints:** should `blueprints/` and `pipelines/` move under their contexts' packages, or stay at the root as data that other tools, such as `test:scaffolds`, read?
