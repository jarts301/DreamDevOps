# Contracts

What each bounded context publishes to the others, to the dashboard and to the agent. It's the only thing contexts share, besides the [shared kernel](../shared-kernel/README.md), so a context can change anything else, or move to a service of its own, without the others noticing.

Each context has a folder, such as `src/builds`, and may have these files in it:

| File | Holds | Who uses it |
|---|---|---|
| `events.ts` | The events the context publishes: each one's type, version, payload schema, and how it reads in the history and in chat | The publisher creates its events only with `Contract.create(...)`, and consumers subscribe with `bus.subscribe(Contract, consumer, handler)`, which checks every event first |
| `services.ts` | The queries and commands the context answers for others, as interfaces, each with a token, such as `COMPANY_DIRECTORY` | The owning context provides the token; others inject it. When the owner becomes a service, an HTTP client implements the same interface |
| `http.ts` | The context's HTTP API: what each route answers, and the bodies it takes | The API's controllers and the dashboard |
| Other files | Rules both sides must apply the same way, such as `environments/protection.ts`, and published vocabulary, such as `identity-access/roles.ts` or `monitoring/metrics.ts` | Whoever needs them |

Besides those:

| File | Holds |
|---|---|
| `src/events.ts` | `EVENT_CATALOG`, every event in the version publishers publish now, for consumers of every event, such as the audit log and chat notifications. `describeRecordedEvent` and `summarizeRecordedEvent` word any recorded event, even one whose shape has since changed. |
| `src/http.ts` | What every HTTP contract shares, such as `Unchecked<T>`, a request body as it arrives, before the API checks it |
| `src/agent/protocol.ts` | What the agent and the API send each other |

Import a file by its path, such as `@dreamdevops/contracts/builds/http`. Everything in a file is public, so keep anything else in the context.

## Rules

These are checked by the tests here and by the API's architecture test:

| Rule | Why |
|---|---|
| Contracts depend only on each other, the shared kernel and Zod | They're what every part depends on, so they can't depend on any part |
| Each `http.ts`, and everything it imports, uses no package and nothing from Node | The dashboard runs them in the browser |
| The dashboard imports only such files | The same |
| The agent imports contracts as types only | Its image needs nothing but its own code |
| Contexts in the API reach each other only through the contracts, and only their Nest modules wire them together | A context's own code can change, or move, freely |
| Events are only made through their contracts | No event is published without one |
| Controllers answer with their contract's types, never a bare `object` | The dashboard and the API agree on every answer at compile time |

## Changing a contract

Contracts are what other parts rely on, so they change only in ways that don't break them.

- **Event payloads:** add optional fields only. A new event must have exactly the contract's fields, so a field the contract forgot fails the publisher's tests, while consumers accept fields they don't know yet.
- **Anything else about an event,** such as removing, renaming or retyping a field, is a new version: a second contract with the same type and `version: 2`. The event bus delivers each version on a topic of its own. Consumers subscribe to the new version alongside the old one first, then the publisher moves to it and `EVENT_CATALOG` lists it instead, and the old contract goes once none of its events are left to deliver. Keep its wording, so the history still reads old entries.
- **HTTP answers:** add fields freely. Removing or renaming one, or changing what it means, needs a new route alongside the old one until the dashboard has moved.
- **Service interfaces:** add methods or optional parameters. Anything else changes every caller, so do it in the same change as them, while they're all in this repository.
- **The agent protocol:** agents in clusters update on their own schedule, so the API must keep understanding what older agents send. Add optional fields only.

## Building

The API's tests, the dashboard and the agent read the sources here directly, through the `@dreamdevops/source` export condition, so they need no build. The running API reads the compiled output, which `npm run build` makes before the API's own build.
