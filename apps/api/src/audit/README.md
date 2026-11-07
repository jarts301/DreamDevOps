# Audit

Keeps a history of every change in each company, which can't be changed or deleted without it showing.

## What it records

Every event any module publishes is recorded, with who caused it and when. Events the platform causes on its own, such as finishing a company's setup, have no person. New event types are recorded automatically.

Payloads hold IDs and roles, not email addresses, so the log doesn't copy personal details.

## Why it can be trusted

- **Append-only:** database triggers refuse every change and deletion, even from the table's owner.
- **Hash chain:** each entry's hash covers its content and the previous entry's hash. Changing, removing or reordering any entry breaks every hash after it, so **Check integrity** finds it.

The chain can't show entries removed from the very end. Fixing that needs the latest hash stored somewhere the database administrator can't change, which isn't built yet.

## Order

Entries are numbered in the order they're recorded, and those numbers make up the chain. Events are delivered in the background, so that order can differ slightly from the order the changes happened. Lists are sorted by when each change happened.

Events published before this module existed aren't in the log.

## Routes

All routes start with `/api/v1`.

| Route | Who | Purpose |
|---|---|---|
| `GET /company/audit` | `audit:read` | The current company's history, newest first. Pass `before` to get older entries. |
| `GET /company/audit/verify` | `audit:read` | Checks the whole chain, and reports the first broken entry |
| `GET /platform/audit` | `audit:read-own` | A platform admin's own actions, across every company |
