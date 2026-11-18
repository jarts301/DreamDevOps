# Shared kernel

The building blocks every DreamDevOps module uses: company context, domain events, the transactional outbox and background jobs.

| Import | Contents |
|---|---|
| `@dreamdevops/shared-kernel` | Company IDs, domain events and what an event contract must do, aggregates, `DomainError`, company context, ports and the event bus, what a store is (`Transactional`, `EventLog`) and a `Logger`, and small helpers such as `isUuid` and `describeError`. It has no database or vendor imports, so domain and application code can depend on it. |
| `@dreamdevops/shared-kernel/postgres` | Tenant transactions, `PostgresSession` and `transactional` for each context's store, the outbox and its relay, the pg-boss adapter and migrations. Only adapters use it. |
| `@dreamdevops/shared-kernel/testing` | An in-memory job queue for fast tests. |

## How a change becomes an event

A use case changes its context's data through the context's store, in one transaction, and records the events the change publishes with it:

```ts
await runWithCompany(companyId, () =>
  store.transaction(async (session) => {
    await session.add(application);
    await session.record([ApplicationRegistered.create({ companyId, actorId, payload })]);
  }),
);
```

The store's PostgreSQL adapter extends `PostgresSession`, whose `record` saves the events to the outbox in the same transaction, and `transactional` runs each piece of work in a tenant transaction with a new session:

```ts
export function postgresCatalogStore(database: TenantDatabase): CatalogStore {
  return transactional(database, (tx) => new PostgresCatalogSession(tx));
}
```

The change and its events commit together, so an event can't be lost or sent for a change that failed. The `OutboxRelay` then passes saved events to the `EventBus`, which runs each subscriber in the event's company context.

Which consumer gets which event is kept by the job queue, in pg-boss's own tables, not in each process. So an event the relay publishes in one API process reaches consumers that subscribed in any other, such as during a rolling deployment, or once a module runs as its own service. A consumer that's removed from the code keeps its subscription until it's removed from the queue too, with pg-boss's `unsubscribe`.

Delivered events stay in the outbox for `OUTBOX_RETENTION_DAYS`, a week by default, and are then removed every night. The audit log keeps every event for good.

## Rules for module code

- **Company identity:** only call `runWithCompany` with an identity the server has established, never with a value sent by a client.
- **Duplicates:** events can arrive more than once if the relay crashes after publishing, and failed handlers run again, so handlers must be idempotent.
- **The last try:** a handler that throws gets the job or event again, until the queue's `retryLimit` runs out. Its second argument says whether this is the last try, `attempt.last`. Work that leaves something waiting, such as a build waiting for its pipeline, must settle it on the last try, such as by failing it with the reason, instead of throwing. Each failed try reaches `onJobFailed`, which the API logs.
- **Other modules' events:** subscribe with the event's contract, `bus.subscribe(Contract, 'consumer', handler)`, from the [contracts](../contracts/README.md). The bus checks each event against it before the handler runs, so the handler gets a typed payload. An event that doesn't hold to it throws `InvalidEventPayloadError`, which sends the event to the dead letter queue, since trying again can't fix it. Throw `UnrecoverableJobError` for any other job that can never succeed.
- **Event versions:** each version of an event type has its own topic, and a contract subscribes to its own version only, so a consumer can read two versions while its publisher moves from one to the next.
- **Ordering:** the relay publishes in saved order, but retries and multiple workers can change the order handlers run in, so handlers shouldn't rely on it.
- **New company tables:** enable and force row-level security, using `kernel.current_company_id()` in the policy, as [the outbox migration](migrations/0001_create-kernel-outbox.sql) does.
- **Long jobs:** a job that takes minutes, such as a build, needs its own queue with `expireInSeconds` and `heartbeatSeconds`, and a worker with a `concurrency`, so it runs one job at a time. Otherwise it may expire while still running and run twice.
- **Recurring jobs:** `queue.schedule(queue, cron)` sends a job to a queue on a cron schedule, in UTC, such as every minute with `* * * * *`. Every process shares the schedule, so each occurrence sends one job, however many processes run, and scheduling again replaces it, so each start can set it. Create the queue and its worker first, with `exclusive: true`, so a slow run never has more piling up behind it. Never use `setInterval` for this: every process would run it. In tests, the in-memory queue sends them when `runSchedules()` is called.
- **Once-only work:** to run something once however many processes start, such as an upgrade, send a job with `deterministicJobId(...)`, which gives the same ID for the same parts.
- **Transactions:** never call another module, or an outside service such as Git, inside a store's `transaction`. The call takes a second connection, or holds this one, while it waits, and with enough of them at once, the pool runs dry and everything stalls. Read first, act with no transaction open, then record in a short one. To keep two jobs from doing the same long work at once, claim a row for a short while, and renew the claim with `withRenewal` while the work runs.

## Database roles

| Role | Used by | Access |
|---|---|---|
| `dreamdevops_owner` | Migrations | Owns the tables |
| `dreamdevops_app` | The application | One company at a time; can only read and add outbox events |
| `dreamdevops_relay` | The outbox relay | Reads every company's events; can only change `published_at`, and remove delivered events through `kernel.purge_published_outbox` |
| `dreamdevops_jobs` | The job queue | Its own `pgboss` schema |

## Tests

| Command, from the repository root | What it runs |
|---|---|
| `npm run test:unit` | Fast tests with no Docker |
| `npm run test:integration` | Tests against a throwaway PostgreSQL, using Docker Desktop |
| `npm test` | Both |

The integration tests don't use the local stack or its data. If Docker can't download an image on the first run, run them again.
