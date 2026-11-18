# Environments and Targets

Keeps each company's environments, the target that runs each one, and each environment's variables and secrets. A target is a Kubernetes cluster with the [DreamDevOps agent](../../../agent/README.md) installed, or **This machine**, the Docker of the machine that runs DreamDevOps, for trying things out. This module is the platform's side of both.

## Environments

| Kind | Accepts | Notes |
|---|---|---|
| Test | RC and final images, and feature images unless turned off | A company can have several, such as one per team. Turn feature images off for the environment where release candidates are tested, so unreviewed code stays off it. |
| Production | Final images only | Its target will trust only the company's release key. |

The kind is fixed at creation, because it decides which signing key the target trusts. The short name is fixed too, because it will name the environment's folder and namespaces. Companies start with no environments.

Environments are archived, never deleted, so their names stay reserved. An environment with a target can't be archived: disconnect the target first, so nothing keeps running unseen.

## Targets

Each environment runs on exactly one target, and a target serves one environment, so test and production never share a cluster.

### Where a target can be

The places are data, in `HOSTING_PROVIDERS` in `domain/hosting-providers.ts`, and `GET /company/environments/providers` lists them with what each needs and whether it can be chosen here. The dashboard builds its choice from that list.

| Provider | Key | Can be chosen | How it runs applications |
|---|---|---|---|
| Kubernetes cluster | `kubernetes` | Yes | The agent, Flux and Argo Rollouts, as below |
| This machine | `local` | When `LOCAL_HOSTING` is on | The platform runs each application as a container on its own Docker. See [This machine](../deployments/README.md#this-machine). |
| Docker host, Amazon Web Services, Microsoft Azure, Google Cloud | `docker`, `aws`, `azure`, `gcp` | Not yet | Listed so people can see what's coming. An environment runs on one target, so one that can't deploy would leave it stuck. |

A target never holds credentials. This machine has one optional setting, the host name people reach it by, which addresses use instead of `localhost`. It's connected as soon as it's chosen: it has no agent, no key and no repository, and it's never lost. Disconnecting it doesn't stop what runs: stop the applications first.

| Status | Meaning |
|---|---|
| Pending | A registration token was made, and the agent hasn't used it yet |
| Connected | The agent registered and reports in |
| Lost | The agent hasn't reported for `TARGET_LOST_AFTER_SECONDS`, 3 minutes by default |
| Revoked | Disconnected. Kept for the history, and no longer shown. |

## Connecting a target, step by step

1. A Company Admin or Operator chooses **Connect a target**, then **Kubernetes cluster**. The platform makes a registration token that works once, within an hour, and shows it in one Helm command. The command is shown only once; only a hash of the token is stored. Asking again replaces an unused token.
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

Each environment has values for all its applications, and each application can have its own, which replace the shared ones of the same name.

- **Names** are letters, digits and underscores, starting with a letter or underscore, such as `DATABASE_URL`. They're case-sensitive, as in any container, but one scope can't have two that differ only in case, and a name is a variable or a secret, never both. `PORT`, `PATH`, `HOSTNAME` and names starting with `DREAMDEVOPS_` belong to the platform or the container.
- **Values** are kept exactly, spaces included, and fit on one line, which is what every container runtime passes on safely. Encode multi-line values, such as keys, in base64. Each is up to 32 KB.
- **Limits:** the environment's shared values, and each application's own, can each hold up to 100 variables and secrets, totalling 256 KB. The size of each secret is kept, never its value.
- **From the platform:** every application also gets `PORT`, the blueprint's, `DREAMDEVOPS_ENVIRONMENT`, the environment's short name, `DREAMDEVOPS_PRODUCTION`, `true` or `false`, and `DREAMDEVOPS_VERSION`.
- **Metrics and traces:** applications also get the standard OpenTelemetry settings: `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_METRIC_EXPORT_INTERVAL` (15000), `OTEL_SERVICE_NAME`, the application's short name, and `OTEL_RESOURCE_ATTRIBUTES` with `dreamdevops.place.id`, `dreamdevops.environment.id` and `dreamdevops.application.id`. The environment's own values can change all but those attributes, which are always added last, so they count. The rules are in Environments' contract `environments/telemetry.ts`, and [Monitoring](../monitoring/README.md#how-telemetry-gets-here) says where it all goes.

| | Variables | Secrets |
|---|---|---|
| Stored in | The platform's database | OpenBao, at `dreamdevops/<company>/<environment>/shared` and `.../apps/<application>` |
| Shown | Name and value, to every member | Name only, to every member. Nobody can read a value back. |
| Reach the application as | A ConfigMap in the environment's repository | A Secret the External Secrets Operator makes in the cluster |

Tech Leads and Operators manage every environment's values (`environment-config:manage`). Company Admins manage test environments' only (`test-environment-config:manage`), so production's values stay with the people who run production.

Changes apply when a version starts: the platform puts the values into the manifests then, and a changed value starts a new rollout. Until then, the application's page says what runs has older values, and **Apply now** runs it again with the new ones. See [Deployment Orchestration](../deployments/README.md#stop-and-apply-now). The platform's own OpenBao token can write, patch and delete secrets but not read them; history stays in OpenBao, and the audit log records names only.

## Approval

A Tech Lead or Operator can make a production environment require a second person's approval for each deployment. See [Deployment Orchestration](../deployments/README.md).

## Production protection

Production is protected from mistakes in several layers. The rules are in Environments' contract `environments/protection.ts`, which Deployments applies too. How long a reason may be is in `environments/http.ts`, which the dashboard uses too.

| Protection | How |
|---|---|
| Only some people | Creating, renaming, archiving, connecting or disconnecting a production environment, or changing its approval, needs `environments-production:manage`, which only Tech Leads and Operators have, besides the route's own permission. Company Admins manage test environments. |
| Confirming by name | Any change to production needs its name typed exactly, such as `Live`, so a slip of the mouse can't do it: those above, its variables and secrets, and deploying, approving, promoting, aborting, rolling back, stopping and applying values. Connecting its target and creating it need none. |
| A reason | Every change but running or steering a version also needs a reason of 10 to 500 characters. For deploying, approving, promoting, aborting and applying values, one is optional. Reasons are saved in the events and on the deployment, so the audit log shows who changed production and why. |

The dashboard asks for the name and reason before it sends a change to production, and the API checks both again. Requests carry them as `confirmation` and `reason`.

## Routes

All routes start with `/api/v1`.

| Route | Who | Purpose |
|---|---|---|
| `GET /company/environments` | Any member | Environments with their target's health. `?status=archived` lists archived ones. |
| `GET /company/environments/:id` | Any member | One environment |
| `POST /company/environments` | `targets:connect` | Creates `{ "name", "kind": "test" \| "production", "acceptsFeatureImages" }` |
| `PATCH /company/environments/:id` | `targets:connect` | Changes the name, whether a test environment accepts feature images, or whether production needs approval (`requiresApproval`). Production also needs `confirmation` and `reason`. |
| `GET /company/environments/:id/config?application=` | Any member | Variables with values, and secret names |
| `PUT`, `DELETE /company/environments/:id/variables/:name` | See above | Sets `{ "value", "application" }` or removes a variable |
| `PUT`, `DELETE /company/environments/:id/secrets/:name` | See above | Sets `{ "value", "application" }` or removes a secret |
| `POST /company/environments/:id/archive`, `/restore` | `targets:connect` | Archives or restores |
| `GET /company/environments/providers` | Any member | Where environments can run, with each one's settings, and why it can't be chosen here, if it can't |
| `POST /company/environments/:id/target` | `targets:connect` | Connects `{ "provider": "kubernetes" \| "local", "settings": {} }`. For a cluster, it returns a registration token and the Helm command; This machine is connected at once. |
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
| `TARGET_OTLP_ENDPOINT` | Where applications in clusters send metrics and traces over OTLP/HTTP. By default, the collector the agent installs, `http://dreamdevops-otel-collector.dreamdevops-system:4318`. `off` tells them to send none. |
| `LOCAL_HOSTING` | `on` lets companies run applications on This machine. On by default, except in production, where companies would share the machine that runs DreamDevOps. |
| `LOCAL_HOSTING_BIND_ADDRESS` | The address applications on This machine publish their ports on. `127.0.0.1` by default, so only this machine reaches them. |
| `DEPLOY_HEALTH_TIMEOUT_SECONDS` | How long a new version on This machine has to become healthy before it's rolled back. Default 120. |

## Not done yet

- **Making clusters:** creating clusters from the dashboard with OpenTofu can come later.
- **Kyverno's newer policy types:** the signature check uses Kyverno's `ClusterPolicy`, which Kyverno now marks as deprecated in favour of `ImageValidatingPolicy`.
- **Rotating secrets:** a new value replaces the old one; there's no scheduled rotation yet.
