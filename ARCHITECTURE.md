# Architecture

DreamDevOps is a modular monolith. Its backend is split into bounded contexts, in the sense of domain-driven design. Each has its own model, tables, API and Nest module. They run in one process and one database today, and are kept apart so that any of them can become its own service when the business needs it.

This guide describes the contexts, the contracts they publish to each other, the rules that keep them apart, and what's left to do before one can be split off. `apps/api/test/architecture.test.ts` and the [contracts' tests](packages/contracts/README.md#rules) check the rules on every test run.

## Contents

- [Contexts](#contexts)
- [Inside a context](#inside-a-context)
- [How contexts work together](#how-contexts-work-together)
- [Contracts](#contracts)
- [Rules](#rules)
- [Platform code](#platform-code)
- [The dashboard](#the-dashboard)
- [Splitting a context into a service](#splitting-a-context-into-a-service)

## Contexts

Each context is a folder in `apps/api/src`, with its own guide. What it publishes is in its folder of [`packages/contracts`](packages/contracts/README.md), and nothing else of it is visible to the others.

| Context | Responsibility | Schema | Publishes, in its contracts | Calls | Hears |
|---|---|---|---|---|---|
| [Identity and access](apps/api/src/identity-access/README.md) | Login, sessions, members, roles and invitations | `identity` | `Principal` and permission checks, role names, `CompanyMembers`, `FirstAdminInvitations`, member and invitation events | Notifications | Nothing |
| [Tenancy](apps/api/src/tenancy/README.md) | The company register, and each company's Git organization | `tenancy` | `CompanyDirectory`, company events | Identity and access, Notifications | Its own events |
| [Audit](apps/api/src/audit/README.md) | Each company's tamper-evident history | `audit` | Its HTTP API only | Tenancy | Every event |
| [Notifications](apps/api/src/notifications/README.md) | Invitation and alert emails, and chat rules | `notification` | `InvitationMailer`, `AlertMailer`, its test event | Tenancy | Every event people can be notified about |
| [Editions](apps/api/src/editions/README.md) | Each company's edition and features | `editions` | `FeatureAccess`, the editions and features, the edition event | Tenancy | Nothing |
| [Blueprints](blueprints/README.md) | Versioned scaffolds for new applications, in several languages and frameworks per type | Files | `BlueprintCatalog`, `BlueprintManifest` | Nothing | Nothing |
| [Catalog](apps/api/src/catalog/README.md) | Each company's applications, and the blueprint each one starts from | `catalog` | `ApplicationDirectory`, application events | Blueprints | Nothing |
| [Source governance](apps/api/src/source-governance/README.md) | Repositories, Git Flow rules and teams | `source` | `RepositoryLookup`, `RepositoryGit`, the checks' names, repository events | Blueprints, Catalog, Tenancy | Application, member and company events |
| [Webhooks](apps/api/src/webhooks/README.md) | Signed Forgejo webhooks, turned into events | `webhooks` | Git events, such as `CodePushed`, and the webhook signature | Nothing | Nothing |
| [Builds](apps/api/src/builds/README.md) | Versioned, scanned and signed images | `builds` | `BuildRequests`, `DeployableImages`, `ImageSigningKeys`, build events | Catalog, Source governance | Git events |
| [Releases](apps/api/src/releases/README.md) | Git Flow releases and hotfixes | `releases` | Release events | Builds, Catalog, Source governance | Git and build events |
| [Environments](apps/api/src/environments/README.md) | Each company's environments, where they're hosted, their agents, variables and secrets, and production protection | `environments` | `EnvironmentDirectory`, `EnvironmentValues`, `EnvironmentGitOps`, `TargetAuthentication`, hosting providers, production protection, the telemetry attributes, environment and target events | Builds, Catalog, Tenancy | Nothing |
| [Deployments](apps/api/src/deployments/README.md) | Deploying versions to environments, through Git for clusters or on This machine, with Stop and Apply now | `deployments` | `RunningVersions`, deployment events | Blueprints, Builds, Catalog, Editions, Environments, Source governance | Its own events |
| [Monitoring](apps/api/src/monitoring/README.md) | The telemetry gateway, and the metrics, logs and traces of each application in each environment, its place, read from Prometheus, Loki, Jaeger and This machine's containers | None, the stores keep the data | `LatestMetrics`, the metrics' definitions | Catalog, Deployments, Environments | Nothing |
| [Alerts](apps/api/src/alerts/README.md) | Alerts on each place's metrics, checked every minute, and their history | `alerts` | Alert events | Catalog, Environments, Identity and access, Monitoring, Notifications, Tenancy | `MemberRemoved`, and its own events |
| Demo | Local only: Demo Company, a demo user for each role, and a demo application for each blueprint | None | Nothing | Identity and access, Tenancy, Catalog, Environments | Nothing |

"Calls" are the services a context uses, which it needs running to do its work. "Hears" are the events it reacts to, which it can do whenever they arrive. One cycle of calls remains: Identity and access emails invitations through Notifications, Notifications names companies in chat messages through Tenancy, and Tenancy has Identity and access invite a new company's first admin. The architecture test knows it, and fails on any new cycle. [Splitting a context into a service](#splitting-a-context-into-a-service) says how to break it.

## Inside a context

Each context uses the same folders, so any of them reads the same way, and each folder has one job:

| Folder | Its job | May use |
|---|---|---|
| `domain/` | The rules, with no I/O, such as versions, Dockerfile checks and Git Flow | Its own domain, the contracts, `shared/`, the shared kernel and Node built-ins |
| `application/` | The use cases, such as registering an application, and the ports they need: its store, and outside tools. Its services implement the interfaces the context publishes in its contracts. | Its own domain and application, the contracts, the shared kernel's core, never its PostgreSQL part |
| `infrastructure/` | Adapters that implement the ports: the context's PostgreSQL store, and clients of outside tools, such as Forgejo and Docker | Its own application and domain, the shared kernel's PostgreSQL part |
| `http/` | Controllers, which carry HTTP to the context's own use cases, and answer with the types in the context's `http.ts` contract | Its own application and domain, the contracts' HTTP types |
| `messaging/` | Subscribers, which carry the events the context reacts to, and its own jobs, to its own use cases | Its own application and domain, the contracts' events |
| `<context>.module.ts` | The Nest module that puts the context together: it picks the adapters, and provides the tokens of the services it publishes, such as `COMPANY_DIRECTORY` | Anything in the context, other contexts' modules, to wire them in |

Use cases depend on ports, and adapters implement them. That's what lets tests swap in fakes, and what will let a context's adapters change, such as for its own database, without its use cases changing. Where a context's domain or application code uses a published type, such as `BuildStatus`, it imports it from the contracts, and may re-export it, so its own code reads the same either way.

### Stores

Each context that keeps data has a store: a port in `application/ports.ts`, such as `CatalogStore`, and its PostgreSQL adapter in `infrastructure/`, such as `postgres-catalog-store.ts`. Use cases work in transactions through it, with a session that has the context's reads and writes, named for what they mean, such as `session.lockNames()` or `session.isSlugTaken(slug)`, and records the events a change publishes:

```ts
return this.#store.transaction(async (session) => {
  const current = await findOrFail(session, id, { lock: true });
  await session.setStatus(id, 'archived');
  await session.record([ApplicationArchived.create({ companyId, actorId, payload: { applicationId: id, name: current.name } })]);
});
```

The change and its events commit together, or neither does. Only the store has SQL, and maps rows to the records its port defines, such as `StoredApplication`. The shared kernel gives stores `Transactional`, `EventLog` and, for PostgreSQL, `PostgresSession` and `transactional`.

## How contexts work together

In order of preference:

1. **Events.** A context records domain events in the same transaction as its change, through the shared kernel's outbox, and others subscribe. Delivery is at least once, so every handler is idempotent. Every event has a contract, which is the only way to make one, and which the event bus checks each event against before a consumer's handler sees it.
2. **Published services.** When a context needs another's data or work now, it injects a token the owner publishes, such as `COMPANY_DIRECTORY`, and calls the interface behind it. Today the owner's own code answers in-process. When the owner becomes a service, an HTTP client implements the same interface, and the callers don't change.

Contexts never import each other's code, and never read or write another context's tables. Besides the contracts, they share only the [shared kernel](packages/shared-kernel/README.md), which holds company context, domain events, the outbox, jobs, `DomainError`, and small helpers such as `isUuid`.

## Contracts

[`packages/contracts`](packages/contracts/README.md) holds what each context publishes, in a folder of its own:

| File | What it is | Example |
|---|---|---|
| `events.ts` | Each event's type, version, payload schema, and how it reads in the history and in chat | `builds/events.ts`: `BuildSucceeded` |
| `services.ts` | The queries and commands it answers, with their tokens | `tenancy/services.ts`: `COMPANY_DIRECTORY`, `CompanyDirectory` |
| `http.ts` | What its routes answer and take, for the dashboard and for the API's controllers | `deployments/http.ts`: `DeploymentView`, `RequestDeployment` |
| Others | Rules and vocabulary both sides must share | `environments/protection.ts`, `identity-access/roles.ts` |

The agent protocol, what the agent and the API send each other, is in `agent/protocol.ts`. The API's controllers and the dashboard use the same `http.ts` types, so a change to an answer that breaks the dashboard fails to compile. The audit log words each entry with its event's contract, so the dashboard shows the API's description rather than keeping its own copy. The [contracts' guide](packages/contracts/README.md#changing-a-contract) says how each kind may change.

## Rules

These are checked by `apps/api/test/architecture.test.ts`:

| Rule | Why |
|---|---|
| Every folder in `src` is a known context or platform code | New contexts are added on purpose, with their schemas and contracts |
| Every context has a Nest module | The module is the unit that moves to a new service |
| Contexts reach each other only through the contracts, and only their Nest modules import each other, to wire them together | Everything else can change freely, and is what a service keeps private |
| The domain uses no framework, database or outer layer | Domain rules stay testable and portable |
| Only adapters and modules use the database, and only adapters hold SQL | How a context keeps its data can change without its use cases changing |
| Use cases don't use adapters, controllers, subscribers, NestJS, or packages other than the shared kernel's core and the contracts | Use cases don't depend on how they're called or what they call |
| Controllers and subscribers carry requests and events only to their own context's use cases, never to its adapters, another context's services or the database | HTTP and messaging stay thin, and each use case has one home |
| Adapters don't reach back into controllers, subscribers or the module | Dependencies point inwards, to the use cases |
| Every context that keeps data has a store, behind a port | Each context's data can move, and its use cases can be tested without it |
| Each context's SQL touches only its own schemas, and the kernel's | Each context's data can move to its own database |
| Only the platform wires other contexts' background work | A context's subscriptions move with it |
| Events are only made through their contracts, and every event people can be notified about has one | No event is published without a contract, and the notification settings never show unknown events |
| Controllers answer with their contracts' types, never a bare `object` | The dashboard and the API agree on every answer |
| Contexts have no cycles of calls between them, other than the known one | A context in a cycle can't run without the others |
| Contexts use only the platform files meant for them, such as access decorators and the background work contract | The platform's guards and wiring stay the platform's business |
| Only the composition root, `app.module.ts`, `background.module.ts` and `demo/`, imports contexts from the platform | The platform doesn't grow into a context |
| Every migration names its context's schema, and uses no other, except known couplings | Each context's data can move to its own database |

The contracts' own tests check that they depend only on each other, the shared kernel and Zod, and that every `http.ts`, and every contract file the dashboard imports, runs in a browser.

Exceptions are listed in the test with a reason, and the list should only shrink, so the test also fails when an exception is no longer needed. Today they are: the `yaml` library in application code, the cycle of calls above, the guards that belong to Identity and access, and the migrations that use another context's schema, such as through foreign keys.

Lint rules, run by `npm run lint` with oxlint, catch code mistakes such as loose equality, `any` and import cycles between files.

## Platform code

Folders that aren't contexts are the platform every context runs on:

| Folder | Holds |
|---|---|
| `platform/` | The global module with settings and the database, and helpers that put modules together |
| `http/` | Guards, the company context for each request, and the single error format. `DomainError` kinds map to HTTP statuses in one place, and a change the database's unique rules refuse, such as after two requests race, answers 409. |
| `background/` | The outbox relay, the job queue, and the outbox's daily clean-up. Each context's `messaging/` subscriptions are plugged in by `background.module.ts`. Recurring work, such as each context's sweeps, runs on job queue schedules that every API process shares, never on timers in each process. |
| `config/` | Settings, read and checked once at startup |
| `session/`, `database/`, `health/` | Sessions, migrations and health checks |
| `shared/` | Small helpers with no business meaning: slugs, names, running command-line tools, sealed boxes, and the Forgejo HTTP client shared by three contexts' adapters |
| `demo/` | Local development only: the demo company and accounts, and a demo application for each blueprint with a Test environment, set up through the contexts' own services when `DEMO_DATA` is on |

`app.module.ts` is the composition root. It lists the contexts' modules, the guards and the error filter, and nothing else.

## The dashboard

The dashboard's feature folders mirror the contexts. Each feature's `*.api.ts` calls its context's routes, with the types from the context's `http.ts` contract, under the names its pages use. It imports only contract files that run in a browser, which the contracts' tests check, and reads them as source, through the `@dreamdevops/source` export condition set in `angular.json` and `vitest.config.ts`.

Each page runs its actions through `core/page-activity.ts`, which shows that the page is busy, reports errors the same way everywhere, and states what happens to the success message. Status badges use tones, `success`, `danger` and `progress`, rather than any one screen's states. Work that runs in steps, such as builds and deployments, shows them with the shared `shared/steps.ts`.

## Splitting a context into a service

Already in place:

- Each context has its own module, schema, contracts and subscriptions.
- Contexts import nothing of each other but their contracts, and don't read each other's tables. The architecture test keeps it that way.
- Each context reaches its own data only through its store, so moving the data to a database of its own changes only the store.
- Every call to another context goes through an interface in the contracts, injected by its token, so an HTTP client can answer it instead.
- Every event has a versioned contract, checked before any consumer sees it, and each version has its own topic, so an event can change without breaking those who hear it.
- The HTTP API's answers are typed in the contracts, so the dashboard can follow a context that moves.
- Errors share one base class, so any service can answer them the same way.
- Forgejo's HTTP client is shared code, not shared state, so each service can keep its own copy or a library.

Still to do, per context, when the time comes:

| Coupling | Where | What to do |
|---|---|---|
| Foreign keys between schemas | For example, `builds.builds` and `source.repositories` reference `catalog.applications`, and most tables reference `tenancy.companies` and `identity.users` | Drop them when moving the data, and keep the IDs. The contexts already treat them as references, not joins. |
| Database functions that read other schemas | `catalog.applications_view`, `builds.builds_view` and `audit.company_entries` read user names from `identity`, `source.member_accounts` reads `identity` and `tenancy`, and `webhooks.repository_owner` reads `source` | Ask Identity for names, or keep a copy fed by its events, such as `RoleGranted` |
| The cycle of calls between Identity and access, Notifications and Tenancy | Invitation emails, company names in chat messages, and the first admin's invitation | Let Notifications keep company names from Tenancy's events, or let Identity and access invite the first admin when it hears `CompanyCreated`, with the link sent by email only |
| Two steps that used to be one | Creating a company, then inviting its first admin, are two transactions in two contexts. If the second fails, the company exists without an invitation, and a platform admin invites its first admin again. | Nothing, unless it happens often. A saga could retry it on its own. |
| In-process calls | Every interface in a `services.ts` | Implement it with an HTTP client, in the calling service |
| One outbox and job queue | `kernel.outbox` and the `pgboss` schema | Give each service its own outbox and relay. Which consumer gets which event is already kept in the job queue's tables, not in each process, so a relay in one service reaches consumers in another. Moving to a broker means implementing `JobQueue`'s `publish` and `subscribe` with it |
| One login session | The API is the dashboard's backend, with a session cookie, and its guards belong to Identity and access | Keep the backend for the dashboard, and let it call services with a signed token for the user and company |
| One settings object | `config/app-config.ts` holds every context's settings | Split it into a section per context before moving one |
| The demo | `demo/` sets up the demo company through the contexts' own services, not their contracts | Move it to the contexts' routes, or drop it from the services |

A context is ready to move when its tables have no foreign keys from or to other schemas, it's in no cycle of calls, and every contract it uses has a client that works over the network.
