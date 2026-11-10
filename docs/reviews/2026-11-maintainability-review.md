# Maintainability review, November 2026

A review of the whole codebase for code smells, missing tests, warnings and the refactoring needed to keep DreamDevOps easy to change as it grows, and to prepare it to be split into services along its bounded contexts later. No context was split. Behavior was kept as it was, and the few places where the internals work differently are listed in [What works differently inside](#what-works-differently-inside).

## Contents

- [Summary](#summary)
- [How behavior was protected](#how-behavior-was-protected)
- [Measurements](#measurements)
- [Changes](#changes)
- [What works differently inside](#what-works-differently-inside)
- [Found but not changed](#found-but-not-changed)
- [Recommended next steps](#recommended-next-steps)
- [What couldn't be checked](#what-couldnt-be-checked)

## Summary

| Area | Before | After |
|---|---|---|
| Bounded contexts | Folders, put together by one 363-line `app.module.ts` | One Nest module per context, with explicit imports and exports, and a 104-line composition root |
| Reading another context's data | Five places queried other contexts' tables with SQL | None. Contexts ask through published interfaces: `CompanyDirectory` and `RepositoryLookup`. |
| Event contracts between contexts | Untyped payloads, cast by each consumer | Typed contracts in the publisher's `domain/events.ts`, checked on both sides |
| Background work | One class knew every context's subscriptions | Each context owns its subscriptions, in `messaging/` |
| Architecture rules | Described only in READMEs | Checked by `test/architecture.test.ts` on every run |
| Duplicated code | Six error classes, six UUID patterns, five error helpers, three Forgejo HTTP clients, three name cleaners, six copies of the dashboard's action handling, ten copies of the test sign-in | One of each |
| Tests | 604 | 661, all passing |
| Compiler checks | Strict, with unused code and template types unchecked | Unused code, missing returns, switch fall-through, overrides and Angular templates also checked |

## How behavior was protected

1. **Characterization tests first.** Before any change, tests were added for the code about to change that had little coverage: the Forgejo adapters of Tenancy and Source Governance, which had only tests that need Docker, and edge cases in Builds, Tenancy and Editions.
2. **The full suites after every step.** Type checks, 68 shared kernel tests, 304 API unit tests, 181 API integration tests against a real PostgreSQL, 108 dashboard tests and the dashboard's production build.
3. **The real server.** The built API was started through its normal entry point against a fresh database, with all migrations. A signed webhook then started a build, which ran through the background queue, retried and failed as designed, and landed in the audit log.
4. **What the running app is made of.** The running app has 58 routes, the same as before, none registered twice, and one instance of each module.
5. **The screens.** The Builds page was rendered in a browser before and after, and its status colors compared by computed style.
6. **The architecture test was tested.** One violation of each rule was put into the code on purpose, each was caught, and the code was restored.

The tests caught one mistake during the work, before it went anywhere: replacement providers given to the app, such as test fakes, were applied first-wins instead of last-wins. A test now checks that rule.

## Measurements

### Tests

| Suite | Before | After | Added |
|---|---|---|---|
| Shared kernel | 65 | 68 | `DomainError`, `isUuid`, `describeError` |
| API unit | 274 | 304 | Forgejo adapters without Docker, architecture rules, shared helpers, module settings, pipeline steps |
| API integration | 174 | 181 | Unavailable Git service, scanning turned off, missing Dockerfile, invalid IDs, company changes that change nothing, a failing license provider |
| Dashboard | 91 | 108 | The shell and its menu, the overview, the message pages, the company guard, `PageActivity`, status tones |

### Coverage

Measured with the same suites before and after. The suites that need Keycloak and Forgejo containers couldn't run here, so their adapters count as uncovered in both.

| | Before | After |
|---|---|---|
| API statements | 88.9% | 94.3% |
| API branches | 78.4% | 83.5% |
| API functions | 92.0% | 95.9% |
| Shared kernel statements | 95.5% | 95.7% |
| Dashboard statements | 93.8% | 94.1% |

Code with no test at all before: the dashboard's shell, overview and message pages, and `companyGuard`.

### Warnings

There were none from the compilers, the test runs or the production build, before or after. The one message in test output, a warning that an invitation email failed, is expected: that test makes the email fail on purpose.

The only warning outside the code is an npm deprecation notice for `glob@10.5.0`, which another package brings in. Nothing in DreamDevOps uses it directly.

## Changes

### Quality gates

- The API and shared kernel now also refuse unused imports, variables and parameters, missing returns, switch fall-through and undeclared overrides. Nothing needed fixing to turn them on.
- The dashboard now states `strict` and `noUncheckedIndexedAccess`, rather than relying on TypeScript's defaults, and checks templates with `strictTemplates` and `typeCheckHostBindings`. The templates passed as they were.

### Duplication removed

| What | Where it was | Now |
|---|---|---|
| Error classes with a kind and a message | Six modules, and an error filter that named each | One `DomainError` base in the shared kernel. The filter maps kinds to statuses in one table, so a new module needs no change there. |
| UUID checks | Six copies of the same pattern | `isUuid` in the shared kernel |
| Shortening errors from other tools | Five copies | `describeError` in the shared kernel |
| Forgejo HTTP requests and error handling | Three adapters, each with its own | `shared/forgejo/forgejo-api.ts`. Each adapter keeps its timeout, and its own error for problems retrying can't fix. |
| Cleaning up names | Company, application and rule names | `shared/names.ts`. Rule names still allow control characters, as they always have. See [Found but not changed](#found-but-not-changed). |
| Dashboard action handling | Six pages, in four slightly different versions | `core/page-activity.ts`, where each page states how it treats its success message, so each behaves as before |
| Test sign-in, unique names and waiting | Up to ten copies | `test/support/integration.ts` |
| Test fakes | One 480-line file | One file per context in `test/fakes/`, re-exported from `test/fakes.ts`, so no import changed |

### Preparing to split into services

- **A Nest module per context**, in `<context>/<context>.module.ts`, exporting only what others may use. `app.module.ts` now only lists them, with the guards and error filter.
- **A global platform module** holds the settings and database. Nest shuts it down last, so the database closes after background work has stopped, as before.
- **Published queries instead of shared tables.** Tenancy publishes `CompanyDirectory`, and Source Governance publishes `RepositoryLookup`. Builds, Editions, Notifications, Source Governance and the webhook receiver use them instead of reading `tenancy.companies` and `source.repositories`.
- **Blueprints behind an interface.** Catalog and Source Governance depended on the class that reads blueprint files. They now use `BlueprintCatalog`.
- **Each context owns its errors.** Source Governance threw Catalog's error class. It now has `SourceError`. The responses are the same.
- **Typed event contracts.** `catalog/domain/events.ts` and `source-governance/domain/events.ts` type the events other contexts react to. Both the code that sends them and the code that handles them are checked against these types.
- **Context-owned background work.** Each context's `messaging/` folder sets up what it reacts to. `BackgroundProcessing` only starts the queue and relay, then hands them to each context, in the same order as before.
- **An enforced architecture.** `test/architecture.test.ts` checks that contexts use each other only through published files, that the domain and application layers stay free of adapters and frameworks, that each context's SQL stays in its own schemas, and that every event has a description on the dashboard. Its two exceptions are listed with reasons.
- **A guide.** [ARCHITECTURE.md](../../ARCHITECTURE.md) describes the contexts, layers, rules and how contexts work together, and lists what's left before a context can move to its own service.

### Builds, the fastest-growing module

- The build pipeline's nine steps are now classes in `application/steps/`, behind one `PipelineStep` interface. The runner went from about 600 lines to 315. Adding a step means adding a file and registering it, and a test checks that every step a build can run has exactly one implementation.
- Reading builds, in `BuildQueries`, is now separate from requesting them, in `Builds`.

### Dashboard

- Build status badges used the company screen's state names, such as `provisioning-failed`, to borrow their colors. Badges now use neutral tones, `success`, `danger` and `progress`, with the same colors.

## What works differently inside

None of these change what people see or what the API answers:

| Where | Before | Now |
|---|---|---|
| Tenancy and Source Governance's Forgejo adapters | Failed responses were left unread | Failed responses are closed, as Builds' adapter already did, which frees their connections sooner |
| Editions, changing a company's edition | Locked the company's row in Tenancy's table | Checks the company through `CompanyDirectory`, and takes a lock of its own, so two changes to one company still happen one after the other |
| Editions, listing every company's edition | One query joining two contexts' tables | Two queries, combined in the same order |
| Source Governance, Notifications and the webhook receiver | Read company and repository rows in their own transactions | Read them through the published interfaces, in separate short queries. They read the same rows. |

## Found but not changed

These would change behavior, need dependencies this environment couldn't install, or are design decisions to make together:

| Finding | Why it matters | Suggestion |
|---|---|---|
| Notification rule names allow control characters, unlike company and application names | Inconsistent rules for the same kind of input | Refuse them, which `normalizeName` can do by changing one option, but it changes what the API accepts |
| The dashboard's pages treat success messages in three ways: clear when the next action starts, clear only if it fails, or have none | People see slightly different behavior on different screens | Choose one and set it in each page's `PageActivity` |
| Tenancy creates a company and its first admin's invitation in one transaction that spans Identity's tables | The biggest obstacle to splitting these two contexts | A saga, as described in ARCHITECTURE.md, once the invitation token can be delivered without the creating request |
| Tables reference other contexts' tables with foreign keys, and some database functions read other schemas | They tie the contexts to one database | Remove them context by context when splitting, as listed in ARCHITECTURE.md |
| One settings object holds every context's settings | Each service will need only its own | Split `AppConfig` into sections per context |
| Two application files use NestJS's `Logger`, and some application code uses `pg` types for queries across companies | Small ties to the framework and database in the application layer | A logging port, and moving those queries into infrastructure |
| The API has no linter or formatter, though its code has ESLint comments | Style and some mistakes aren't checked automatically | Add ESLint and Prettier, as the blueprints and dashboard have |
| Coverage isn't part of the test commands | Coverage can quietly drop | Add `@vitest/coverage-v8` and a minimum coverage level |
| Identity's and Tenancy's events that Source Governance reacts to, such as `RoleGranted` and `CompanySuspended`, aren't typed | It uses only their names today, but they're still contracts between contexts | Type them in Identity's and Tenancy's `domain/events.ts`, as Catalog and Source Governance now do |

## Recommended next steps

In order:

1. Add ESLint and Prettier to the API, and a coverage minimum to every package, so these findings can't come back unnoticed.
2. Split `AppConfig` into sections per context.
3. Replace the shared Tenancy and Identity transaction with a saga, because it blocks splitting either of them.
4. When the first context is to become a service, follow the checklist in [ARCHITECTURE.md](../../ARCHITECTURE.md#splitting-a-context-into-a-service). Builds is the easiest candidate: it publishes nothing other contexts depend on, and uses others only through interfaces.

## What couldn't be checked

This environment has no Docker, so these existing suites didn't run: Keycloak login, the real Forgejo for organizations and repositories, blueprint scaffolds, and the browser test of the main flow. The code they cover changed only in ways the new Docker-free tests check: the Forgejo adapters' HTTP handling, and the wiring of the module each adapter is in. Run `npm test`, `npm run test:e2e` and `npm run test:scaffolds` with Docker before merging.

PostgreSQL 16 stood in for 17, and Node 24.21 was used. A few dependencies were one patch version older than the lockfile pins, because the exact versions weren't available. The lockfile and package files are unchanged.
