# Alerts

Emails people when what runs in one of their company's environments needs attention. Each alert watches one metric of one environment, such as the CPU of production, and fires when the metric stays past its threshold for long enough. It emails the company members it names when it fires, and again when it's resolved, and never anyone who has left the company. The dashboard shows them under **Alerts**.

Alerts read the metrics [Monitoring](../monitoring/README.md) shows, and email through [Notifications](../notifications/README.md). Locally, [Mailpit](http://localhost:8025) catches every email, so nothing leaves your machine.

## Contents

- [What an alert says](#what-an-alert-says)
- [How alerts are checked](#how-alerts-are-checked)
- [Emails](#emails)
- [Changing an alert](#changing-an-alert)
- [Routes](#routes)
- [Permissions](#permissions)
- [Events](#events)
- [Data separation](#data-separation)
- [Try it locally](#try-it-locally)
- [Not included yet](#not-included-yet)

## What an alert says

| Part | What it is | Example |
|---|---|---|
| Name | 2 to 80 characters, unique in the company | *High CPU* |
| Environment | One of the company's environments, of any application | *Billing API · Production* |
| Metric | One of the five Monitoring shows: `cpu`, `memory`, `requests`, `responseTime` or `errors` | CPU |
| Comparator | `above` or `below` the threshold | above |
| Threshold | In the metric's own unit, as the API gives metrics: percent for CPU and server errors, bytes for memory, requests each second, and seconds for response time. The dashboard asks for memory in MiB and response times in ms. Server errors go up to 100%. | `80` |
| Minutes | How long the metric must stay past the threshold before the alert fires, from 0, at once, to 60 | `5` |
| Members to email | 1 to 10 of the company's members, each once. Alerts keep their user IDs, not their addresses. | *Ana Ops* |

Several alerts can watch the same metric of one environment, such as a warning at 70% and another at 90%.

`domain/alert.ts` holds these rules.

## How alerts are checked

Every minute, a scheduled job checks every alert that's on, in every active company. Suspended companies' alerts wait.

1. **Scheduling:** the job queue's schedule sends `alerts.check` every minute. Every API process shares the schedule, so each minute sends one job, however many processes run.
2. **Companies:** that job queues one `alerts.evaluate` job per company with an alert that's on. Its ID names the company and the minute, so a company is checked once a minute, and one company's slow check doesn't hold up another's.
3. **Values:** the check asks Monitoring, through `LatestMetrics`, for its environments' latest values, the ones the **Monitoring** table shows.
4. **States:** each alert moves between three states, in `domain/evaluation.ts`:

| State | Means | Next |
|---|---|---|
| OK | The metric isn't past the threshold | Past it: **Waiting**, or **Firing** at once for 0 minutes |
| Waiting | Past the threshold, not yet for its minutes | Still past it for its minutes: **Firing**, and emails. Back: **OK**, and nobody's told. |
| Firing | Past the threshold for its minutes | Back: **OK**, and emails that it's resolved. Still past it: nothing more. |

- **Timing:** a check a few seconds early counts a minute as passed, so an alert for 5 minutes fires 5 minutes after the metric went past, give or take the minute between checks.
- **No value:** when an environment sends nothing for two minutes, or nothing runs in it, its metric has no value, and nothing is past a threshold, as in Prometheus. A firing alert is then resolved, with *No data* as its value.
- **Metrics unreadable:** when the metrics store can't answer, alerts keep their state, and show why on the dashboard. Without `PROMETHEUS_URL`, nothing is checked, and the dashboard says metrics aren't set up.
- **History:** each time an alert fires is an incident, until it's resolved. The dashboard shows the latest 50.

A failed check isn't tried again: the next minute's check takes its place.

## Emails

When an alert fires or is resolved, its state and the event that says so are saved together. The event then queues one email per member, in `alerts.email`, through `AlertEmails`, which [Notifications](../notifications/README.md#alert-emails) publishes.

- **Only current members:** alerts name members, and learn who is a member, and their address, from [Identity and access](../identity-access/README.md)'s `CompanyMembers`. Each email is checked twice: when it's queued, and again just before it's sent, so someone removed in between isn't emailed either. It goes to the address they have then.
- **Removed members are taken off:** when someone is removed from the company, `MemberRemoved` takes them off every alert, so they stay off even if they rejoin. Until that's done, the dashboard already leaves them out.
- **Each member on their own:** a failing mailbox doesn't hold up or repeat the others. A failure is tried 4 more times, `NOTIFICATION_RETRY_SECONDS` apart, and the last failure shows on the alert.
- **Once each:** the job's ID names the event and the member, so each change reaches each member once, even if its event arrives twice.
- **Alerts from before:** alerts created before migration `0017` named addresses. Each address became the member of the company with that address, and addresses of nobody in the company were dropped.
- **Nobody left:** an alert whose members have all left emails nobody, and the dashboard says so. New and changed alerts must name at least one member. A deleted alert emails nobody.
- **Test emails:** **Test email** on the dashboard sends every member it names an email saying it's a test, straight away, and says whether they all went.

The email says which alert, what it watches, the latest value, since when it fires, and for how long it fired once resolved, with a link to the dashboard's **Alerts**. Emails are in UTC, since they can't know the reader's time zone.

Chat rules can post `AlertTriggered` and `AlertResolved` to Slack or any webhook too, as they can any event on the **Notifications** page.

## Changing an alert

- **What can change:** its name, threshold, minutes and members, and whether it's on. A new threshold or number of minutes counts from the next check, so an alert that fires can be resolved by raising its threshold.
- **What can't:** what it watches, its environment, metric and comparator, so its emails and history always describe it truly. To watch something else, create another alert.
- **Turning it off** ends a firing alert's incident without an email, as *Turned off*, and it's checked again once it's on.
- **Deleting it** removes its history too.

## Routes

All routes start with `/api/v1`, and need the `monitoring` feature, which every edition includes.

| Route | Who | Purpose |
|---|---|---|
| `GET /company/alerts` | `dashboards:view` | Every alert, with its state, latest value and any problem. `metricsEnabled` says whether metrics are kept, and `metrics` lists them with their units. `recipients` lists the members it emails, with `userId`, `displayName` and `email`, leaving out anyone who has left. It's null for members without `alerts:manage`, who see `recipientCount` only. |
| `GET /company/alerts/incidents` | `dashboards:view` | The latest 50 times an alert fired, newest first, with how each ended |
| `GET /company/alerts/members` | `alerts:manage` | Whom alerts can email: the company's members, with `userId`, `displayName` and `email` |
| `POST /company/alerts` | `alerts:manage` | Creates an alert from `name`, `environmentId`, `metric`, `comparator`, `threshold`, `forMinutes` and `recipients`, the user IDs of members. Anyone who isn't a member is refused. |
| `PATCH /company/alerts/:id` | `alerts:manage` | Changes `name`, `threshold`, `forMinutes`, `recipients` or `enabled` |
| `DELETE /company/alerts/:id` | `alerts:manage` | Deletes an alert and its history |
| `POST /company/alerts/:id/test` | `alerts:manage` | Emails every member it names a test. Answers `delivered`, how many were `sent`, and the first `error`. |

## Permissions

| Role | Sees alerts | Manages them |
|---|---|---|
| Company Admin | Yes | Yes |
| Tech Lead | Yes | Yes |
| Operator | Yes | Yes |
| Developer | Yes | |
| Viewer | Yes | |

`alerts:manage` follows `environments:manage`: those who run applications decide what wakes people up, so they can see every member's name and address to choose from. Everyone who views dashboards sees alerts and their history, but not whom they email.

## Events

Published through the outbox, with contracts in `domain/events.ts`. The audit log records them all.

| Event | When | Actor |
|---|---|---|
| `AlertCreated` | An alert is created | Who created it |
| `AlertUpdated` | An alert changes, with what changed in `changes` | Who changed it |
| `AlertDeleted` | An alert is deleted | Who deleted it |
| `AlertTriggered` | An alert starts firing | None: the platform noticed |
| `AlertResolved` | A firing alert's metric is back | None |

Payloads hold the alert, its condition in words, the environment's and application's names, and for the last two, the value in words. They never hold whom it emails, only how many members, so the audit log and chat never show anyone's address.

This context also reacts to Identity's `MemberRemoved`, whose contract is in `identity-access/domain/events.ts`.

## Data separation

- **Tables:** `alerts.alerts` and `alerts.incidents` have row-level security, forced, by company. Other contexts' IDs, such as the environment's, are kept without foreign keys, so this context's data can move to its own database.
- **Members:** an alert can only email members of its own company, found through Identity's `CompanyMembers`, which answers in the current company only. Their IDs are kept without foreign keys.
- **Environments:** an alert can only watch an environment the company has, found through Environments' `RunningEnvironments`, which answers in the current company only.
- **Metrics:** Monitoring's `LatestMetrics` asks the metrics store only about environments that run in the current company, whichever IDs it's given.
- **Checks:** each company is checked in its own company context, and the scheduled job reads only which companies to check.

## Try it locally

1. Start the local services, the API and the dashboard, as the [main guide](../../../../README.md#getting-started) says, and deploy a version to an environment, such as Staging.
2. Sign in as `dev-operator`, open **Alerts**, and create an alert on Staging: **CPU**, **Above**, threshold `0`, **At once**, emailing yourself, who's chosen at first, and `dev-viewer`. Or open **Monitoring**, choose **Show details** on an environment, and follow **Set up an alert**.
3. Choose **Test email**, and open <http://localhost:8025>: the test email is there.
4. Within a minute, the alert shows **Firing**, and Mailpit has its *[Firing]* email. The **History** shows it under **Still firing**.
5. **Edit** it, and raise the threshold to `90`. Within a minute, it's **OK**, Mailpit has its *[Resolved]* email, and the **Audit log** records each change.
6. As `dev-company-admin`, remove `dev-viewer` on **Team**. The alert no longer names them, and when it fires again, only you get the email.

## Not included yet

- **Reminders:** an alert that keeps firing emails once, when it starts. Nobody is reminded later.
- **Silences:** there's no way to quiet an alert for a time, other than turning it off.
- **Teams or roles as recipients:** an alert names members one by one, not everyone in a role, so a new Operator isn't emailed until someone adds them.
- **Alerts on limits:** thresholds are values, such as 450 MiB, not shares of the container's limit, such as 90%.
- **Alerts on logs and traces:** only the five metrics are watched.
- **Absent data:** an application that stops sending metrics resolves its alerts, rather than firing one. Failed deployments are better followed with a chat rule on `DeploymentFailed`.
