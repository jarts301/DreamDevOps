# Webhook gateway

Turns signed Forgejo webhooks into domain events that other modules react to.

## How a delivery is checked

Each repository's webhook is set up by Source Governance with its own secret, derived from `WEBHOOK_SECRET_KEY` and the application ID, so no secret is stored. Changing the key and reapplying the hooks replaces every secret.

1. The gateway finds which application the repository belongs to.
2. It checks Forgejo's HMAC-SHA256 signature of the exact body against that repository's secret, in constant time. An unknown repository and a wrong signature get the same `401`, so neither is revealed.
3. It records the delivery ID, so a delivery sent twice, or replayed, is handled once.
4. It saves the events in the company's outbox, in the same transaction.

## Events

| Forgejo event | Domain event |
|---|---|
| Push to a branch | `CodePushed`, with the branch, the new commit and the pusher's Git username |
| Push that deletes a branch, or a `delete` event | `BranchDeleted` |
| `create` of a branch | `BranchCreated` |
| Pull request opened | `PullRequestOpened` |
| Pull request merged | `PullRequestMerged`, with the merge commit |

Tag pushes are ignored, because only the platform makes version tags. So is any event nothing reacts to. Payloads hold branch names, commits and Git usernames, which are Keycloak user IDs, never names or emails.

## Route

`POST /api/v1/webhooks/forgejo` is public, because Forgejo has no session. The signature is what proves who sent it. Bodies over 1 MB are refused.

## Settings

| Setting | Purpose |
|---|---|
| `WEBHOOK_SECRET_KEY` | At least 32 characters. The API refuses to start in production with the sample value. |
| `TOOLS_API_URL` | Where Forgejo and CI jobs reach the API. Locally, `http://host.docker.internal:4000`. |
