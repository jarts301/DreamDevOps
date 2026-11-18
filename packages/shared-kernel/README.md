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

Which consumer gets which event is kept by the job queue, in pg-boss's own tables, not in each process. So an event the relay publishes in one API process reaches consumers that subscribed in any other, such as during a rolling deployment, or once a module runs as its own service. A consumer that's removed from the code keeps its subscription until it's removed from the queue too, with pg-boss's `unsubscribe`.

Delivered events stay in the outbox for `OUTBOX_RETENTION_DAYS`, a week by default, and are then removed every night. The audit log keeps every event for good.

## Rules for module code

- **Company identity:** only call `runWithCompany` with an identity the server has established, never with a value sent by a client.
- **Duplicates:** events can arrive more than once if the relay crashes after publishing, and failed handlers run again, so handlers must be idempotent.
- **Other modules' events:** read the fields a handler needs with `payloadOf(event).text('buildId')`, rather than a cast. A missing or malformed field throws `InvalidEventPayloadError`, which sends the event to the dead letter queue, since trying again can't fix it. Throw `UnrecoverableJobError` for any other job that can never succeed.
- **Ordering:** the relay publishes in saved order, but retries and multiple workers can change the order handlers run in, so handlers shouldn't rely on it.
- **New company tables:** enable and force row-level security, using `kernel.current_company_id()` in the policy, as [the outbox migration](migrations/0001_create-kernel-outbox.sql) does.
- **Long jobs:** a job that takes minutes, such as a build, needs its own queue with `expireInSeconds` and `heartbeatSeconds`, and a worker with a `concurrency`, so it runs one job at a time. Otherwise it may expire while still running and run twice.
- **Recurring jobs:** `queue.schedule(queue, cron)` sends a job to a queue on a cron schedule, in UTC, such as every minute with `* * * * *`. Every process shares the schedule, so each occurrence sends one job, however many processes run, and scheduling again replaces it, so each start can set it. Create the queue and its worker first, with `exclusive: true`, so a slow run never has more piling up behind it. Never use `setInterval` for this: every process would run it. In tests, the in-memory queue sends them when `runSchedules()` is called.
- **Once-only work:** to run something once however many processes start, such as an upgrade, send a job with `deterministicJobId(...)`, which gives the same ID for the same parts.
- **Transactions:** never call another module, or an outside service such as Git, inside `TenantDatabase.transaction`. The call takes a second connection, or holds this one, while it waits, and with enough of them at once, the pool runs dry and everything stalls. Read first, act with no transaction open, then record in a short one. To keep two jobs from doing the same long work at once, claim a row for a short while, and renew the claim with `withRenewal` while the work runs.

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
