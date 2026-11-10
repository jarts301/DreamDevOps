# Environments and Targets

Keeps each company's environments, the target that runs each one, and each environment's variables and secrets. A target is a Kubernetes cluster with the [DreamDevOps agent](../../../agent/README.md) installed; this module is the platform's side of it.

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
5. The agent makes an SSH key for Flux and sends its public half with `PUT /agent/deploy-key`. The platform creates the environment's repository, `environment-<short name>` in the company's Forgejo organization, and adds the key as its only, read-only deploy key. No team can see the repository.
6. The agent fetches `GET /agent/configuration` and sets up the cluster: the repository and Forgejo's SSH host key, the key its environment trusts (the release key in production, the test key elsewhere), the company's read-only registry login, and a two-hour OpenBao token that can only read this environment's secrets.
7. Every 30 seconds the agent calls `POST /agent/heartbeat` with its access token. The platform checks for silent targets every 30 seconds, and marks a connected target that stopped reporting as lost. It's connected again as soon as it reports.

Each company gets one read-only registry account, made the first time a target needs it, in a `targets` team that can read packages and no code. Creating it is the only thing the platform does with `FORGEJO_ADMIN_USERNAME`'s rights. Its token is stored encrypted.

Disconnecting cuts the target off at once: its key, its access token and any unused registration token stop working. A new target can then connect.

Every agent call only goes out from the cluster, over HTTPS in production, so a machine needs no open inbound port. Agent routes have no session; each checks its own proof, and they share the stricter sign-in rate limit. An unknown target and a wrong token get the same `401`.

## Variables and secrets

Each environment has values for all its applications, and each application can have its own, which replace the shared ones of the same name. Names are capital letters, digits and underscores; `PORT`, `DREAMDEVOPS_ENVIRONMENT` and `DREAMDEVOPS_VERSION` are set by the platform.

| | Variables | Secrets |
|---|---|---|
| Stored in | The platform's database | OpenBao, at `dreamdevops/<company>/<environment>/shared` and `.../apps/<application>` |
| Shown | Name and value, to every member | Name only, to every member. Nobody can read a value back. |
| Reach the application as | A ConfigMap in the environment's repository | A Secret the External Secrets Operator makes in the cluster |

Tech Leads and Operators manage every environment's values (`environment-config:manage`). Company Admins manage test environments' only (`test-environment-config:manage`), so production's values stay with the people who run production.

Changes apply at the next deployment: the platform puts the values into the manifests then, and a changed value starts a new rollout. The platform's own OpenBao token can write, patch and delete secrets but not read them; history stays in OpenBao, and the audit log records names only.

## Approval

A Company Admin or Operator can make a production environment require a second person's approval for each deployment. See [Deployment Orchestration](../deployments/README.md).

## Routes

All routes start with `/api/v1`.

| Route | Who | Purpose |
|---|---|---|
| `GET /company/environments` | Any member | Environments with their target's health. `?status=archived` lists archived ones. |
| `GET /company/environments/:id` | Any member | One environment |
| `POST /company/environments` | `targets:connect` | Creates `{ "name", "kind": "test" \| "production", "acceptsFeatureImages" }` |
| `PATCH /company/environments/:id` | `targets:connect` | Changes the name, whether a test environment accepts feature images, or whether production needs approval (`requiresApproval`) |
| `GET /company/environments/:id/config?application=` | Any member | Variables with values, and secret names |
| `PUT`, `DELETE /company/environments/:id/variables/:name` | See above | Sets `{ "value", "application" }` or removes a variable |
| `PUT`, `DELETE /company/environments/:id/secrets/:name` | See above | Sets `{ "value", "application" }` or removes a secret |
| `POST /company/environments/:id/archive`, `/restore` | `targets:connect` | Archives or restores |
| `POST /company/environments/:id/target` | `targets:connect` | Returns a registration token and the Helm command |
| `DELETE /company/environments/:id/target` | `targets:connect` | Disconnects the target |
| `POST /agent/register` | The registration token | Registers the agent's public key |
| `POST /agent/token` | A signed assertion | Returns an access token |
| `PUT /agent/deploy-key` | The access token | Registers Flux's read-only SSH key |
| `GET /agent/configuration` | The access token | What the target needs, with a fresh OpenBao token |
| `POST /agent/heartbeat` | The access token | Reports in, with how deployments are doing; returns commands |

## Events

`EnvironmentCreated`, `EnvironmentUpdated`, `EnvironmentArchived`, `EnvironmentRestored`, `EnvironmentVariableSet`, `EnvironmentVariableRemoved`, `EnvironmentSecretSet`, `EnvironmentSecretRemoved`, `TargetRegistrationStarted`, `TargetConnected`, `TargetLost` and `TargetRevoked` are recorded in the audit log. Secret events carry names, never values. Company Admins can be notified of environments being created or archived, and of targets connecting, getting lost and being disconnected.

## Settings

| Setting | Purpose |
|---|---|
| `AGENT_API_URL` | Where agents reach the API. Default: `API_PUBLIC_URL`. Must use https in production. |
| `AGENT_CHART` | The agent's Helm chart, shown in the command. The local start script points it at the locally published chart. |
| `TARGET_LOST_AFTER_SECONDS` | How long a target can be silent before it counts as lost. Default 180. |
| `OPENBAO_URL`, `OPENBAO_TOKEN` | Where the API reaches OpenBao, and its token, which can't read secret values. The API renews it every 12 hours. |
| `FORGEJO_ADMIN_USERNAME`, `FORGEJO_ADMIN_PASSWORD` | A Forgejo administrator, used only to create each company's registry account |
| `TARGET_REGISTRY_HOST`, `TARGET_OPENBAO_URL`, `TARGET_GIT_SSH_URL`, `TARGET_GIT_KNOWN_HOSTS` | How targets reach the registry, OpenBao and Git, and Forgejo's SSH host keys. They default to the platform's own addresses. |

## Not done yet

- **Making clusters:** creating clusters from the dashboard with OpenTofu can come later.
- **Kyverno's newer policy types:** the signature check uses Kyverno's `ClusterPolicy`, which Kyverno now marks as deprecated in favour of `ImageValidatingPolicy`.
- **Rotating secrets:** a new value replaces the old one; there's no scheduled rotation yet.
