# Architecture

DreamDevOps is a modular monolith. Its backend is split into bounded contexts, in the sense of domain-driven design. Each has its own model, tables, API and Nest module. They run in one process and one database today, and are kept apart so that any of them can become its own service when the business needs it.

This guide describes the contexts, the rules that keep them apart, and what's left to do before one can be split off. `apps/api/test/architecture.test.ts` checks the rules on every test run.

## Contents

- [Contexts](#contexts)
- [Inside a context](#inside-a-context)
- [How contexts work together](#how-contexts-work-together)
- [Rules](#rules)
- [Platform code](#platform-code)
- [The dashboard](#the-dashboard)
- [Splitting a context into a service](#splitting-a-context-into-a-service)

## Contexts

Each context is a folder in `apps/api/src`, with its own guide.

| Context | Responsibility | Schema | Publishes to other contexts | Uses |
|---|---|---|---|---|
| [Identity and access](apps/api/src/identity-access/README.md) | Login, sessions, members, roles and invitations | `identity` | `Principal` and permission checks, email rules, `CompanyAccessService` | Notifications |
| [Tenancy](apps/api/src/tenancy/README.md) | The company register, and each company's Git organization | `tenancy` | `CompanyDirectory` | Identity and access, Notifications |
| [Audit](apps/api/src/audit/README.md) | Each company's tamper-evident history | `audit` | Nothing | Every context's events |
| [Notifications](apps/api/src/notifications/README.md) | Invitation emails and chat rules | `notification` | `InvitationEmails` | `CompanyDirectory`, every context's events |
| [Editions](apps/api/src/editions/README.md) | Each company's edition and features | `editions` | `EntitlementProvider`, `RequireFeature` | `CompanyDirectory` |
| [Blueprints](blueprints/README.md) | Versioned scaffolds for new applications | Files | `BlueprintCatalog`, blueprint types | Nothing |
| [Catalog](apps/api/src/catalog/README.md) | Each company's applications | `catalog` | `ApplicationCatalog`, application events | Blueprints |
| [Source governance](apps/api/src/source-governance/README.md) | Repositories, Git Flow rules and teams | `source` | `RepositoryLookup`, Git Flow, repository events | Catalog, Blueprints, `CompanyDirectory` |
| [Builds](apps/api/src/builds/README.md) | Versioned, scanned and signed images | `builds` | `DeployableImages` | Catalog, `RepositoryLookup`, `CompanyDirectory` |
| [Environments](apps/api/src/environments/README.md) | Each application's environments, hosting targets, deployments and production protection | `environments` | Environment, hosting target and deployment events, `RunningEnvironments`, the attribute metrics carry | Catalog, Builds' `DeployableImages` |
| [Monitoring](apps/api/src/monitoring/README.md) | Metrics of what runs in each environment, read from Prometheus | None, Prometheus keeps the metrics | Nothing | Environments' `RunningEnvironments`, Catalog |

The dependencies form no cycle. Tenancy publishes `CompanyDirectory` in a Nest module of its own, so contexts that only read companies don't depend on the rest of Tenancy.

## Inside a context

Each context uses the same folders, so any of them reads the same way:

| Folder | Holds | May use |
|---|---|---|
| `domain/` | Rules and types with no I/O, such as versions, Dockerfile checks and Git Flow | Its own domain, other contexts' published domain files, `shared/`, the shared kernel and Node built-ins |
| `application/` | Use cases, ports for outside tools, and published query interfaces | Its own domain and application, other contexts' published files, the shared kernel |
| `infrastructure/` | Adapters for outside tools, such as Forgejo, Docker and PostgreSQL | Its own application and domain |
| `http/` | Controllers, the REST API | Its own context |
| `messaging/` | The events the context reacts to, and its own job queues | Its own context |
| `<context>.module.ts` | The Nest module that puts the context together, and what it exports | Other contexts' modules and published tokens |

Application code depends on ports, such as `BuildSource` or `SourceHost`, and infrastructure implements them. That's what lets tests swap in fakes, and what will let a context's adapters change without its use cases changing.

## How contexts work together

In order of preference:

1. **Events.** A context records domain events in the same transaction as its change, through the shared kernel's outbox, and others subscribe. Delivery is at least once, so every handler is idempotent. Events that other contexts consume have typed contracts in the publisher's `domain/events.ts`, such as `RepositoryCreated`. Change them only compatibly, or with a new event version.
2. **Published queries.** When a context needs another's data now, it asks through an interface the owner publishes, such as `CompanyDirectory` or `RepositoryLookup`. Today the owner's own code answers in-process. When the owner becomes a service, an HTTP client implements the same interface, and the callers don't change.
3. **Published application services.** A few use cases call another context's service directly, such as Source governance calling `ApplicationCatalog.get`. They're listed as published in the architecture test.

Contexts never read or write another context's tables. They also never share code except through the [shared kernel](packages/shared-kernel/README.md), which holds company context, domain events, the outbox, jobs, `DomainError`, and small helpers such as `isUuid`.

## Rules

These are checked by `apps/api/test/architecture.test.ts`:

| Rule | Why |
|---|---|
| Every folder in `src` is a known context or platform code | New contexts are added on purpose, with their schemas and published files |
| Every context has a Nest module | The module is the unit that moves to a new service |
| Contexts import only each other's published files | Everything else can change freely, and is what a service keeps private |
| The domain uses no framework, database or outer layer | Domain rules stay testable and portable |
| Application code doesn't use adapters, controllers or NestJS | Use cases don't depend on how they're called or what they call |
| Each context's SQL touches only its own schemas, and the kernel's | Each context's data can move to its own database |
| Only the platform wires other contexts' background work | A context's subscriptions move with it |
| Every published event has a dashboard description, and every notifiable event exists | The audit log and notification settings never show unknown events |

Exceptions are listed in the test with a reason, and the list should only shrink. Today there are two: NestJS's logger in two application files, and the `@casl/ability` permission library in the identity domain.

## Platform code

Folders that aren't contexts are the platform every context runs on:

| Folder | Holds |
|---|---|
| `platform/` | The global module with settings and the database, and helpers that put modules together |
| `http/` | Guards, the company context for each request, and the single error format. `DomainError` kinds map to HTTP statuses in one place. |
| `background/` | The outbox relay and job queue. Each context's `messaging/` subscriptions are plugged in by `background.module.ts`. |
| `config/` | Settings, read and checked once at startup |
| `session/`, `database/`, `health/` | Sessions, migrations and health checks |
| `shared/` | Small helpers with no business meaning: slugs, names, step progress, running command-line tools, and the Forgejo HTTP client shared by three contexts' adapters |
| `sample-data/` | Local development only: the sample company and accounts, set up through the contexts' own services when `SAMPLE_DATA` is on |

`app.module.ts` is the composition root. It lists the contexts' modules, the guards and the error filter, and nothing else.

## The dashboard

The dashboard's feature folders mirror the contexts. Each page runs its actions through `core/page-activity.ts`, which shows that the page is busy, reports errors the same way everywhere, and states what happens to the success message. Status badges use tones, `success`, `danger` and `progress`, rather than any one screen's states. Work that runs in steps, such as builds and deployments, shows them with the shared `shared/steps.ts`.

## Splitting a context into a service

Already in place:

- Each context has its own module, schema, published interfaces, event contracts and subscriptions.
- Contexts don't read each other's tables, and the architecture test keeps it that way.
- Errors share one base class, so any service can answer them the same way.
- Forgejo's HTTP client is shared code, not shared state, so each service can keep its own copy or a library.

Still to do, per context, when the time comes:

| Coupling | Where | What to do |
|---|---|---|
| Foreign keys between schemas | For example, `builds.builds` and `source.repositories` reference `catalog.applications`, and most tables reference `tenancy.companies` and `identity.users` | Drop them when moving the data, and keep the IDs. The contexts already treat them as references, not joins. |
| Database functions that read other schemas | `catalog.applications_view`, `builds.builds_view` and `audit.company_entries` read user names from `identity`, and `source.member_accounts` reads `identity` and `tenancy` | Ask Identity for names, or keep a copy fed by its events, such as `RoleGranted` |
| A shared transaction | Tenancy creates a company and its first admin's invitation in one transaction, through `CompanyAccessService.inviteFirstAdminIn` | Make it a saga: Identity creates the invitation when it hears `CompanyCreated`, and the token is delivered by email only |
| In-process calls | `CompanyDirectory`, `RepositoryLookup`, `BlueprintCatalog`, `ApplicationCatalog.get`, `InvitationEmails`, `RunningEnvironments` | Implement each interface with an HTTP client, in the calling service |
| One outbox and job queue | `kernel.outbox` and the `pgboss` schema | Give each service its own outbox and relay, and publish events to a shared broker |
| One login session | The API is the dashboard's backend, with a session cookie | Keep the backend for the dashboard, and let it call services with a signed token for the user and company |
| One settings object | `config/app-config.ts` holds every context's settings | Split it into a section per context before moving one |

A context is ready to move when the architecture test shows it imports nothing but published files, its tables have no foreign keys from or to other schemas, and every call it makes to another context goes through an interface.
