# Shared kernel

The building blocks every DreamDevOps module uses: company context, domain events, the transactional outbox and background jobs.

| Import | Contents |
|---|---|
| `@dreamdevops/shared-kernel` | Company IDs, domain events, aggregates, `DomainError`, company context, ports and the event bus, and small helpers such as `isUuid` and `describeError`. It has no database or vendor imports, so domain code can depend on it. |
| `@dreamdevops/shared-kernel/postgres` | Tenant transactions, the outbox and its relay, the pg-boss adapter and migrations. |
| `@dreamdevops/shared-kernel/testing` | An in-memory job queue for fast tests. |

## How a change becomes an event

```ts
await runWithCompany(companyId, () =>
  tenantDatabase.transaction(async (tx) => {
    await saveApplication(tx, application);
    await appendToOutbox(tx, application.pullEvents());
  }),
);
```

The change and its events commit together, so an event can't be lost or sent for a change that failed. The `OutboxRelay` then passes saved events to the `EventBus`, which runs each subscriber in the event's company context.

## Rules for module code

- **Company identity:** only call `runWithCompany` with an identity the server has established, never with a value sent by a client.
- **Duplicates:** events can arrive more than once if the relay crashes after publishing, and failed handlers run again, so handlers must be idempotent.
- **Ordering:** the relay publishes in saved order, but retries and multiple workers can change the order handlers run in, so handlers shouldn't rely on it.
- **New company tables:** enable and force row-level security, using `kernel.current_company_id()` in the policy, as [the outbox migration](migrations/0001_create-kernel-outbox.sql) does.
- **Long jobs:** a job that takes minutes, such as a build, needs its own queue with `expireInSeconds` and `heartbeatSeconds`, and a worker with a `concurrency`, so it runs one job at a time. Otherwise it may expire while still running and run twice.

## Database roles

| Role | Used by | Access |
|---|---|---|
| `dreamdevops_owner` | Migrations | Owns the tables |
| `dreamdevops_app` | The application | One company at a time; can only read and add outbox events |
| `dreamdevops_relay` | The outbox relay | Reads every company's events; can only change `published_at` |
| `dreamdevops_jobs` | The job queue | Its own `pgboss` schema |

## Tests

| Command, from the repository root | What it runs |
|---|---|
| `npm run test:unit` | Fast tests with no Docker |
| `npm run test:integration` | Tests against a throwaway PostgreSQL, using Docker Desktop |
| `npm test` | Both |

The integration tests don't use the local stack or its data. If Docker can't download an image on the first run, run them again.
