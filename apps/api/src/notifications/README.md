# Notifications

Sends invitation emails, and posts chosen company events to chat tools.

## Invitation emails

Every invitation is emailed as soon as it's saved, including the first admin of a new company. The email holds the one-time link, which works only for the invited address.

The token exists only in memory and in the email, so the email is sent straight away, not through a stored background job. If sending fails, the invitation still exists, the API reports `emailSent: false`, and the dashboard asks the inviter to send the link themselves.

Locally, [Mailpit](http://localhost:8025) catches every email, and nothing leaves your machine.

## Chat rules

Company Admins create rules with the `notifications:manage` permission. A rule chooses events and a webhook address.

| Format | What's posted |
|---|---|
| Slack | `{ "text": "..." }`, for a Slack incoming webhook |
| Generic JSON | The message text, plus the event's type, time, company and payload |

- **Delivery:** each rule gets its own background job per event, so a failing webhook doesn't hold up or repeat the others. Failures are retried 4 times, and the last error shows on the rule.
- **Timing:** rules apply to events as they're delivered, so a rule made just after a change may still receive it.
- **Secrets:** webhook addresses often contain a secret, so the API never shows them in full after saving, only their site.

## Webhook safety

Rules take only `https://` addresses without a password. When posting, the API refuses any address on this machine, the internal network or a cloud metadata service. It checks the address it actually connects to, so a name can't point somewhere else between the check and the request. It doesn't follow redirects.

For local testing only, `WEBHOOK_ALLOW_INSECURE=true` allows `http://` addresses and `WEBHOOK_ALLOW_PRIVATE_NETWORKS=true` allows internal ones. The API refuses to start in production with either.

## Settings

| Setting | Purpose |
|---|---|
| `SMTP_HOST`, `SMTP_PORT` | The mail server |
| `SMTP_SECURITY` | `starttls` (default), `tls`, or `none` for local mail catchers only |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | Optional sign-in for the mail server |
| `SMTP_FROM` | The sender, such as `DreamDevOps <no-reply@example.com>` |
