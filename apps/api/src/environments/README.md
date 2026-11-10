# Environments and Targets

Keeps each company's environments, and the target that runs each one: a Kubernetes cluster with the DreamDevOps agent installed. This module is the platform's side. The agent itself is module 15.

## Environments

| Kind | Accepts | Notes |
|---|---|---|
| Test | RC and final images, and feature images unless turned off | A company can have several, such as one per team. Turn feature images off for the environment where release candidates are tested, so unreviewed code stays off it. |
| Production | Final images only | Its target will trust only the company's release key. |

The kind is fixed at creation, because it decides which signing key the target trusts. The short name is fixed too, because it will name the environment's folder and namespaces. Companies start with no environments.

Environments are archived, never deleted, so their names stay reserved. An environment with a target can't be archived: disconnect the target first, so nothing keeps running unseen.

## Targets

Each environment runs on exactly one target, and a target serves one environment, so test and production never share a cluster.

| Status | Meaning |
|---|---|
| Pending | A registration token was made, and the agent hasn't used it yet |
| Connected | The agent registered and reports in |
| Lost | The agent hasn't reported for `TARGET_LOST_AFTER_SECONDS`, 3 minutes by default |
| Revoked | Disconnected. Kept for the history, and no longer shown. |

## Connecting a target, step by step

1. A Company Admin or Operator chooses **Connect a target**. The platform makes a registration token that works once, within an hour, and shows it in one Helm command. The command is shown only once; only a hash of the token is stored. Asking again replaces an unused token.
2. Someone with access to the cluster runs the command. It installs the agent into the `dreamdevops-system` namespace.
3. The agent makes an Ed25519 key pair inside the cluster, and calls `POST /agent/register` with the token and its public key only. The target is then connected, and the dashboard shows the key's fingerprint.
4. From then on, the agent proves itself with its own key. To get an access token, it signs a short assertion: a JWT, as in RFC 7523, with its target ID as issuer and subject and the token address as audience, lasting at most two minutes. Each assertion works once. The access token lasts 15 minutes, and only the newest one works.
5. Every 30 seconds the agent calls `POST /agent/heartbeat` with its access token. The platform checks for silent targets every 30 seconds, and marks a connected target that stopped reporting as lost. It's connected again as soon as it reports.

Disconnecting cuts the target off at once: its key, its access token and any unused registration token stop working. A new target can then connect.

Every agent call only goes out from the cluster, over HTTPS in production, so a machine needs no open inbound port. Agent routes have no session; each checks its own proof, and they share the stricter sign-in rate limit. An unknown target and a wrong token get the same `401`.

## Routes

All routes start with `/api/v1`.

| Route | Who | Purpose |
|---|---|---|
| `GET /company/environments` | Any member | Environments with their target's health. `?status=archived` lists archived ones. |
| `GET /company/environments/:id` | Any member | One environment |
| `POST /company/environments` | `targets:connect` | Creates `{ "name", "kind": "test" \| "production", "acceptsFeatureImages" }` |
| `PATCH /company/environments/:id` | `targets:connect` | Changes the name, or whether a test environment accepts feature images |
| `POST /company/environments/:id/archive`, `/restore` | `targets:connect` | Archives or restores |
| `POST /company/environments/:id/target` | `targets:connect` | Returns a registration token and the Helm command |
| `DELETE /company/environments/:id/target` | `targets:connect` | Disconnects the target |
| `POST /agent/register` | The registration token | Registers the agent's public key |
| `POST /agent/token` | A signed assertion | Returns an access token |
| `POST /agent/heartbeat` | The access token | Reports in, with the agent and Kubernetes versions |

## Events

`EnvironmentCreated`, `EnvironmentUpdated`, `EnvironmentArchived`, `EnvironmentRestored`, `TargetRegistrationStarted`, `TargetConnected`, `TargetLost` and `TargetRevoked` are recorded in the audit log. Company Admins can be notified of environments being created or archived, and of targets connecting, getting lost and being disconnected.

## Settings

| Setting | Purpose |
|---|---|
| `AGENT_API_URL` | Where agents reach the API. Default: `API_PUBLIC_URL`. Must use https in production. |
| `AGENT_CHART` | The agent's Helm chart, shown in the command. The default is a placeholder until module 15 publishes the chart. |
| `TARGET_LOST_AFTER_SECONDS` | How long a target can be silent before it counts as lost. Default 180. |

## Not done yet

- **The agent and its chart:** module 15. Until then, the command can't be run, and tests play the agent.
- **Deployments:** module 16 will check that a version's kind is one the environment accepts, and give production targets only the release key.
- **Approvals per environment:** second-person approval and separate permissions for production come with Deployment Orchestration.
- **Making clusters:** creating clusters from the dashboard with OpenTofu can come later.
