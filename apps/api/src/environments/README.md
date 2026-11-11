# Environments

Keeps each application's environments, such as development, staging and production, where each one runs, and which version runs in each. Any environment can be marked as production, which protects it from mistakes, and production runs only releases.

Environments run on the company's **hosting targets**. Every company starts with one for **This machine**, the Docker of the machine that runs DreamDevOps, and new environments run there unless someone chooses otherwise. Companies can also connect cloud accounts and servers of their own, and move an environment to one of them with one change.

Deploying runs an image from [Builds](../builds/README.md) in an environment: its signature is checked, the image is pulled, started beside the version before it, and that version is removed only once the new one is healthy. The dashboard shows every step.

Each environment has its own **variables and secrets**, which its containers get as environment variables when they start. Secrets are encrypted, and never shown again.

## Contents

- [Hosting targets](#hosting-targets)
- [Environments](#environments-1)
- [Deploying](#deploying)
- [Variables and secrets](#variables-and-secrets)
- [This machine](#this-machine)
- [Production protection](#production-protection)
- [Permissions](#permissions)
- [Routes](#routes)
- [Events](#events)
- [For other modules](#for-other-modules)
- [Settings](#settings)
- [Not included yet](#not-included-yet)

## Hosting targets

A hosting target is one place where environments can run, such as the company's own machine, its AWS account in `eu-west-1`, or its own Kubernetes cluster. Targets are listed, and connected, on the dashboard's **Hosting** page.

Each target uses one of these providers:

| Provider | Key | Kind | Deploys now | Settings |
|---|---|---|---|---|
| This machine | `local` | Self-hosted | Yes | An optional host name people reach it by. `localhost` by default. |
| Kubernetes cluster | `kubernetes` | Self-hosted | Not yet | API server address (`https://` only), and an optional domain for applications |
| Docker host | `docker` | Self-hosted | Not yet | Host name or IP address, and SSH port, 22 by default |
| Amazon Web Services | `aws` | Cloud | Not yet | 12-digit account ID and region, such as `eu-west-1` |
| Microsoft Azure | `azure` | Cloud | Not yet | Subscription ID and region, such as `westeurope` |
| Google Cloud | `gcp` | Cloud | Not yet | Project ID and region, such as `europe-west1` |

Environments can be placed on any target, so they can be planned now. Deploying works on targets whose provider deploys, and says so on the others.

- **Checked settings:** each setting is checked for its form, and a setting the provider doesn't have is refused, so nothing unchecked is saved. Addresses must use HTTPS and can't hold a user name or password.
- **No credentials:** targets hold no passwords, keys or tokens. When the platform deploys to other providers, credentials will be kept in a secret store, never in the database.
- **Fixed provider:** a target's provider can't change. To move environments from one place to another, connect a target for the new place and switch the environments to it.
- **Names:** each target's name is unique in the company, and stays reserved while the target is archived.
- **Archiving:** a target can be archived only when no active environment uses it, and no version runs on it.

### Adding a provider

Providers are data, in `HOSTING_PROVIDERS` in `domain/hosting-providers.ts`. To add one, add an entry there with a new `key`, its kind, whether it `deploys`, and its settings. Each setting has a type (`url`, `hostname`, `port` or `text` with a `pattern`), an example and optional help. The dashboard builds its form from this list, so it needs no change.

To make a provider deploy, write a `HostRuntime` for it in `infrastructure/`, as `local-docker-runtime.ts` does for This machine, add it to `HOST_RUNTIMES` in `environments.module.ts`, and set its `deploys` to `true`. The deployment steps stay the same.

Never change or remove a provider's `key`, or a setting's `key`: saved targets and published events use them. Targets of a provider that's removed can still be used and archived, but their settings can't change.

## Environments

Each application has its own environments. An environment has:

| Field | Rules |
|---|---|
| Name | 2 to 40 characters, unique in the application, such as `Staging` |
| Short name | Made from the name when the environment is created, such as `staging`, and never changes, because it names the environment's container. 30 characters at most. |
| Production | Whether it's production, which protects it |
| Hosting target | An active target of the company. Without a choice, the company's target for This machine. `targetId: null` leaves it for later. |
| Version | What runs in it now, if anything, and where people reach it |

- **Archiving:** archiving keeps the environment and its history, so it can be restored. An environment that runs a version must be stopped first. Restoring needs its hosting target to be active.
- **Order:** the list shows environments that aren't production first, so production comes last, as it does in a release's path.
- **Applications:** environments can't be added to an archived application.

### Changing where an environment runs

Choose another target for the environment, with **Edit** on the **Environments** page. If nothing runs in it, that's all. If a version runs in it, the platform moves it:

1. The same version, by the same digest, is deployed on the new target, with every step a deployment has.
2. Once it's healthy there, it's removed from the old target. If that fails, the move still counts, and the step shows a warning that names the container to remove by hand.
3. If it doesn't become healthy on the new target, it's removed there, and the version on the old target keeps running. The environment shows that it still runs on the old target, and **Deploy** moves it again.

Because a move deploys, it needs the permission to deploy to the environment as well, and a target whose provider deploys. A move to a target that can't run the version yet is refused, so nothing stops running by surprise.

## Deploying

People who deploy choose **Deploy** on an environment, then a version. The list holds the application's images that built, newest first: releases, release and hotfix candidates, and development images of feature pull requests. Production offers only releases.

Each deployment runs these steps in the background, and saves its progress after each one:

| Step | What it does | It fails when |
|---|---|---|
| Check the version and environment | Checks again what was checked when it was asked for, as things may have changed | The environment was archived or moved, the target was archived or can't be deployed to, the image is gone, or production would run anything but a release |
| Verify the signature | Reads the image's signatures from the registry, and checks one was made with the platform's key for this repository and digest | No signature checks out. Nothing is pulled. |
| Pull the image | Downloads the image by its digest, only from the platform's registry | The registry refuses it |
| Start the new version | Reads the environment's variables, opens its secrets, and starts the image with them as the environment's container. The version before it is kept, stopped. | A secret can't be opened, or the container can't start |
| Wait until it's healthy | Waits for the image's health check, up to `DEPLOY_HEALTH_TIMEOUT_SECONDS`, then removes the version before | It reports unhealthy, stops, or isn't healthy in time |
| Remove it from the previous host | Moves only: removes it from the old target | Never. A failure is a warning. |

- **Rolling back:** when the new version can't start, or a step after **Start** fails, the new version is removed and the one before starts again, with its address. The step says which version runs now. If none could start, the environment shows that nothing runs.
- **Digests, not tags:** images run by digest, so what runs is exactly what was built, scanned and signed, even if someone moves a tag in the registry.
- **Retries:** a temporary problem, such as Docker restarting, runs the deployment again from the start, up to `DEPLOY_MAX_ATTEMPTS` times. A failed check never runs again. To try again, deploy again.
- **One at a time:** an environment has at most one deployment queued or running. Protecting, archiving or moving an environment waits for it too.
- **Stopping:** **Stop** removes what runs, and the environment's network, from its host. Nothing runs until the next deployment.
- **History:** each environment keeps every deployment with its steps, newest first, under **Deployments**. The person who asked, and their reason, if any, are kept as they were.

## Variables and secrets

Each environment has its own variables and secrets, such as `LOG_LEVEL` or `DATABASE_URL`, under **Variables** on the **Environments** page. An image is built once, and each environment gives it its own settings.

- **Loaded as the container starts:** the **Start the new version** step reads the environment's variables, and opens its secrets, right before it starts the container, and the container gets them as environment variables. So a change applies the next time a version starts in the environment, and never to one already running.
- **Applying a change:** until a version starts again, the environment shows that what runs has older settings. **Apply now** deploys the version that runs again, with every step and a rollback if it isn't healthy.
- **Plain variables** are kept as they are, and every member can read their values.
- **Secrets** are sealed as soon as they arrive, and their values are never shown again, only replaced or removed. A secret can't become a plain variable, nor the other way round. Mark passwords, tokens and keys as secret.
- **Never in the clear elsewhere:** events, the audit log, chat notifications and deployment steps name variables, never their values, not even plain ones. Steps list which variables and secrets a container started with.
- **From the platform:** every container also gets `DREAMDEVOPS_ENVIRONMENT`, the environment's short name, `DREAMDEVOPS_PRODUCTION`, `true` or `false`, and `DREAMDEVOPS_VERSION`. Names starting with `DREAMDEVOPS_` are kept for them.
- **Metrics and traces:** when the platform keeps them, every container also gets the standard OpenTelemetry settings for sending them, which [Monitoring](../monitoring/README.md) shows:
  - `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, where to send them
  - `OTEL_METRIC_EXPORT_INTERVAL`, 15000 milliseconds
  - `OTEL_SERVICE_NAME`, the application's short name
  - `OTEL_RESOURCE_ATTRIBUTES` with `dreamdevops.environment.id`, the environment's ID

  The environment's own variables can change all but the last, to send them elsewhere, or under another name. If it has its own `OTEL_RESOURCE_ATTRIBUTES`, the platform adds the environment's ID at the end of them, so it counts. The rules are in `domain/telemetry.ts`.
- **Names** are letters, digits and underscores, starting with a letter or underscore, such as `DATABASE_URL`. They're case-sensitive, as in any container, but one environment can't have two that differ only in case. `PATH` and `HOSTNAME` belong to the container.
- **Values** are kept exactly, spaces included, and fit on one line, which is what every container runtime passes on safely. Encode multi-line values, such as keys, in base64. Each is up to 32 KB, and an environment has up to 100, totalling 256 KB.
- **Production:** changing production's variables is protected like any change to it: it needs `environments-production:manage`, its name typed exactly, and a reason.

### How secrets are kept

Secrets are encrypted with AES-256-GCM and a key only the API holds, in `SECRETS_KEY_FILE`, never in the database. Each secret has its own random nonce, and is bound to its company, environment and name, so a sealed value copied anywhere else doesn't open. Each records which key sealed it.

On a developer's machine, the API creates the key on first start in `infra/local/secrets/`, which Git ignores. In production, the API refuses to start unless the setting names an existing key. Keep the key, and back it up apart from the database: secrets sealed with a lost key can't be opened, and must be set again. If a secret can't be opened, the deployment fails at **Start the new version**, before anything stops, and says which one to set again.

On This machine, values reach Docker through an env file only the API's user can read, in a folder of its own, removed as soon as the container is created, so no value appears in a command's arguments. Like any container's environment variables, they're then visible to whoever can run `docker inspect` on the machine.

## This machine

The `local` provider runs applications on the Docker of the machine that runs the API, which is the developer's machine locally. Every company gets one target for it, called **This machine**, the first time its targets are listed or an environment is created without a target. A company can't connect a second one, and one it archived stays archived.

Each environment gets:

- **One container**, named after the application and environment, such as `dreamdevops-billing-api-staging-0b5f8a2c1d3e`, and labelled with the company, application, environment, deployment and version.
- **Its own Docker network**, so it can't reach other environments' or other companies' containers.
- **A port on 127.0.0.1**, chosen by Docker on the first deployment and kept after that, so its address, such as `http://localhost:49153`, stays the same. Only the image's first single TCP port, such as `8080/tcp`, is published. Set `LOCAL_HOSTING_BIND_ADDRESS` to let other machines reach it, and the target's host name so addresses use the name people know.

Containers run hardened: with no Linux capabilities, no privilege escalation, 512 MB of memory, one CPU and 256 processes at most, and they restart with Docker. Images already run as a user other than root, and have a health check, as [Builds](../builds/README.md#the-steps) requires. Pulling uses the platform's registry account in a throwaway Docker configuration, never the person's own.

This machine is for trying things out and for small teams. Every company's applications share the machine that runs DreamDevOps, and, as with builds, they run code from the company's own developers: an application can reach services this machine offers to its containers, such as Docker Desktop's `host.docker.internal`. That includes Prometheus and Jaeger, which applications must reach to send their metrics and traces, and which answer questions about every company's. So on a server shared by several companies, or one that holds data applications mustn't reach, set `LOCAL_HOSTING=off`. Companies then can't connect it, and existing targets for it can't be deployed to.

## Production protection

Production environments are protected from mistakes in several layers:

| Protection | How |
|---|---|
| Only releases | Production runs only releases: images merged into `main`, tagged and signed. Candidates and development images are refused when asked for, again when the deployment runs, and by the database. An environment that runs anything else can't be made production until a release is deployed to it, or it's stopped. |
| Only some people | Deploying to production or stopping it needs `deployments-production:run`. Marking an environment as production, creating one, and changing one need `environments-production:manage`. Only Tech Leads and Operators have them. Company Admins manage other environments, but not production, and deploy nowhere. |
| Confirming by name | Deploying to production, stopping it, changing its variables, renaming it, switching its target or removing its protection needs its name typed exactly, such as `Production`. A slip of the mouse can't do it. |
| A reason | Every change but a deployment also needs a reason of 10 to 500 characters. A deployment's reason is optional. Reasons are saved in the events, so the audit log shows who changed production and why. |
| Rolling back | A release that doesn't become healthy is removed, and the one before runs again. |
| No archiving | Production can't be archived. Its protection must be removed first, which is itself a confirmed change with a reason. The database refuses an archived production environment too. |
| Targets production runs on | Renaming such a target, or changing its settings, is protected like production: it needs `environments-production:manage`, the target's name typed exactly, and a reason. |
| No overwriting | Every change sends the `version` it was based on. If someone else changed it meanwhile, the change is refused, and the dashboard asks to reload. |
| Nothing deleted | The API's database role can't delete targets, environments or deployments. They're archived, and their history stays. |
| Chat alerts | Company Admins can post deployments and production changes to chat through [notification rules](../notifications/README.md). |

The rules are in `domain/protection.ts` and `domain/deployment.ts`. The dashboard asks for the name and reason before it sends a change to production, and the API checks them again.

## Permissions

| Action | Permission | Company Admin | Tech Lead | Developer | Operator | Viewer |
|---|---|---|---|---|---|---|
| See environments, hosting targets and deployments | Any member | Yes | Yes | Yes | Yes | Yes |
| Connect, change and archive hosting targets | `targets:connect` | Yes | | | Yes | |
| Create, rename, move and archive environments | `environments:manage` | Yes | Yes | | Yes | |
| Add, change and remove variables and secrets | `environments:manage` | Yes | Yes | | Yes | |
| Anything about production environments | `environments-production:manage` | | Yes | | Yes | |
| Deploy to and stop other environments | `deployments-test:run` | | Yes | Yes | Yes | |
| Deploy to and stop production | `deployments-production:run` | | Yes | | Yes | |

Moving an environment that runs a version needs `environments:manage` and the permission to deploy to it. Changing a target production runs on needs both `targets:connect` and `environments-production:manage`, so only Operators can.

## Routes

All routes start with `/api/v1`. Changes return the changed environment or target, with its new `version`. Deployments return the queued deployment, with `202 Accepted`.

| Route | Who | Purpose |
|---|---|---|
| `GET /company/hosting-providers` | Any member | The providers, the settings each needs, and whether each deploys |
| `GET /company/hosting-targets?status=active` | Any member | The company's targets, with how many active environments use each, how many run a version on it, and whether production does. `status` is `active` (default) or `archived`. |
| `POST /company/hosting-targets` | `targets:connect` | Connects a target: `{ "name": "AWS Ireland", "provider": "aws", "settings": { "accountId": "123456789012", "region": "eu-west-1" } }` |
| `PATCH /company/hosting-targets/:id` | `targets:connect` | Renames it or changes its settings: `{ "version": 1, "name": "…", "settings": {…} }`. Add `confirmation` and `reason` if production runs on it. |
| `POST /company/hosting-targets/:id/archive` | `targets:connect` | Archives it: `{ "version": 2 }` |
| `POST /company/hosting-targets/:id/restore` | `targets:connect` | Restores it |
| `GET /company/applications/:id/environments?status=active` | Any member | The application's environments, each with the version that runs in it and any deployment under way |
| `POST /company/applications/:id/environments` | `environments:manage`, and `environments-production:manage` for production | Creates one: `{ "name": "Staging", "targetId": "…", "production": false }`. Without `targetId`, it runs on This machine. |
| `PATCH /company/environments/:id` | `environments:manage`, and the permission to deploy to it if a version runs in it and it moves | Renames it or switches its target: `{ "version": 1, "name": "…", "targetId": "…" }`. `targetId: null` clears it. Production also needs `confirmation` and `reason`. |
| `POST /company/environments/:id/protect` | `environments:manage` and `environments-production:manage` | Marks it as production: `{ "version": 1, "reason": "…" }`. The reason is optional here. |
| `POST /company/environments/:id/unprotect` | `environments:manage` and `environments-production:manage` | Removes the protection: `{ "version": 2, "confirmation": "Production", "reason": "…" }` |
| `POST /company/environments/:id/archive` | `environments:manage` | Archives it. Production, and environments that run a version, are refused. |
| `POST /company/environments/:id/restore` | `environments:manage` | Restores it |
| `GET /company/environments/:id/versions` | Any member | The application's images that built, newest first, each with the `problem` that keeps it out of this environment, if any |
| `GET /company/environments/:id/deployments` | Any member | The environment's deployments, newest first, with each one's steps |
| `POST /company/environments/:id/deployments` | `deployments-test:run`, or `deployments-production:run` for production | Deploys a version: `{ "buildId": "…", "reason": "…" }`. Production also needs `"confirmation": "Production"`. |
| `POST /company/environments/:id/stop` | `deployments-test:run`, or `deployments-production:run` for production | Stops what runs. Production also needs `confirmation` and `reason`. |
| `GET /company/deployments/:id` | Any member | One deployment, with its steps |
| `GET /company/environments/:id/variables` | Any member | The environment's variables with their values, and its secrets without theirs |
| `POST /company/environments/:id/variables` | `environments:manage`, and `environments-production:manage` for production | Adds one: `{ "name": "DATABASE_URL", "value": "…", "secret": true }`. Production also needs `confirmation` and `reason`. |
| `PATCH /company/variables/:id` | The same | Replaces its value: `{ "value": "…", "version": 1 }`. Its name, and whether it's secret, stay the same. |
| `DELETE /company/variables/:id` | The same | Removes it: `{ "version": 2 }`, with `204 No Content` |

Errors use the API's `application/problem+json` format: `400` for invalid input, a missing confirmation or reason, `403` without the permission, `404` for an unknown ID or another company's, and `409` for a changed version, a name in use, archiving production or a target in use, a deployment under way, an image production mustn't run, or a target that can't be deployed to.

## Events

Every change publishes an event, and the audit log records them all:

| Event | When | Can post to chat |
|---|---|---|
| `HostingTargetConnected` | A target is connected, including This machine, which the platform connects | Yes |
| `HostingTargetUpdated` | A target is renamed or its settings change. Says whether production runs on it, and the reason. | Yes |
| `HostingTargetArchived`, `HostingTargetRestored` | A target is archived or restored | |
| `EnvironmentCreated` | An environment is created, with its target and provider | Yes |
| `EnvironmentRenamed` | An environment is renamed | |
| `EnvironmentTargetSwitched` | An environment moves to another target, with where it ran before | Yes |
| `EnvironmentProtected`, `EnvironmentUnprotected` | An environment becomes, or stops being, production, with the reason | Yes |
| `EnvironmentArchived` | An environment is archived | Yes |
| `EnvironmentRestored` | An environment is restored | |
| `DeploymentQueued` | Someone asks to deploy, move or stop a version, with their reason | Yes |
| `DeploymentSucceeded` | A version runs, moved or stopped, with its address | Yes |
| `DeploymentFailed` | A deployment fails, with the step, the error, and the version that still runs, if any | Yes |
| `EnvironmentVariableSet` | A variable or secret is added or changed, by name, with the reason | Yes |
| `EnvironmentVariableRemoved` | A variable or secret is removed, by name, with the reason | Yes |

Creating a production environment publishes `EnvironmentCreated` and then `EnvironmentProtected`. Moving an environment that runs a version publishes `EnvironmentTargetSwitched` and then `DeploymentQueued`.

These events, in `domain/events.ts`, are the module's contract with the modules that will set up infrastructure and watch what runs. Keep their names and fields compatible, or publish a new event version.

## For other modules

[Monitoring](../monitoring/README.md) uses two published queries, both in the current company only:

| Query | In | Answers |
|---|---|---|
| `RunningEnvironments` | `application/running-environments.ts` | The active environments a version runs in, or one environment |
| `EnvironmentLogs` | `application/environment-logs.ts` | The lines the version in an environment wrote since a moment, read from its container on the host it runs on, through the runtime's `logs` |

`domain/telemetry.ts` holds the attribute metrics and traces carry, `dreamdevops.environment.id`, which both modules use.

## Settings

| Setting | Purpose |
|---|---|
| `LOCAL_HOSTING` | `on` (default) lets companies run applications on This machine. `off` turns it off, which servers shared by several companies should do. |
| `LOCAL_HOSTING_BIND_ADDRESS` | The IP address applications on This machine publish their ports on. `127.0.0.1` by default, so only this machine reaches them. `0.0.0.0` lets other machines reach them. |
| `DEPLOY_HEALTH_TIMEOUT_SECONDS` | How long a new version has to become healthy before it's rolled back. 120 by default. |
| `DEPLOY_MAX_ATTEMPTS`, `DEPLOY_RETRY_SECONDS` | Runs before a deployment that keeps hitting temporary problems fails, and the wait between them. 2 and 15 by default. |
| `SECRETS_KEY_FILE` | The key that seals secrets: 32 random bytes, in base64. Required in production. Create one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`, readable only by the API's user. |
| `APP_METRICS_OTLP_ENDPOINT` | Where containers send their metrics, as they reach it, such as `http://host.docker.internal:9090/api/v1/otlp/v1/metrics`, which `npm run start:api` sets. Unset, containers aren't told to send any. |
| `APP_TRACES_OTLP_ENDPOINT` | Where containers send their traces, as they reach it, such as `http://host.docker.internal:4318/v1/traces`, which `npm run start:api` sets. Unset, containers aren't told to send any. |

Pulling can take up to `BUILD_TIMEOUT_MINUTES`, as pushing does. Up to two deployments run at once in each API process, each in its own environment.

## Not included yet

- **Other providers:** only This machine deploys. Kubernetes clusters, Docker hosts over SSH and the clouds can be planned for, but not deployed to.
- **Credentials:** there's no secret store for the credentials other providers will need.
- **Rotating the secrets key:** secrets record which key sealed them, but there's no way yet to reseal them with a new key. Until there is, a new key means setting every secret again.
- **Secrets as files:** secrets reach containers only as environment variables, not as files, so values must fit on one line.
- **Sharing settings:** variables belong to one environment. Copying them to another, or sharing some across an application's environments, comes later.
- **Zero downtime:** the version before stops a moment before the new one starts, so they can share a port, and the environment is briefly unreachable.
- **Promoting:** a version is deployed to each environment by hand. Promoting one from staging to production in one step comes later.
- **Two-person approval:** a change to production needs one person with the permission. Requiring a second person's approval is a candidate for the Commercial Edition's approval policies.
