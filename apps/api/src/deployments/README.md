# Deployment Orchestration

Runs versions of applications in environments. On a cluster, a deployment is a commit to the environment's own Git repository; the target's Flux applies it, Argo Rollouts runs it, and the agent reports how it goes. So every cluster behaves the same way, and Git keeps the history of what ran. On [This machine](#this-machine), the platform runs the container itself.

## A deployment, step by step

1. Someone picks a version, an environment and a strategy on the application's page.
2. The platform checks the request:
   - **Who:** Developers, Tech Leads and Operators deploy to test; Tech Leads and Operators to production, with its name typed to confirm. See [Production protection](../environments/README.md#production-protection).
   - **What:** the version passed every check, and the environment accepts its kind. Production takes final versions only, and test environments take feature images only if they accept them.
   - **Where:** the environment's target is connected.
   - **One at a time:** only one deployment of an application to an environment can be under way.
3. If the environment requires approval, which only production can, a second Tech Lead or Operator approves or rejects it. Nobody approves their own deployment.
4. The platform renders the application's manifests and commits them to the environment repository, under `apps/<application>/`. It fills in the environment's variables, where its secrets are, the blueprint's port, health checks and resources, and the image by digest.
5. Flux in the target applies the commit. The agent reports the rollout with each heartbeat, and the dashboard shows each step: saved to Git, applied by the target, rolling out with how many pods are ready, and for blue/green, the traffic switch.
6. When the rollout is healthy, the deployment has succeeded, and earlier ones of the same application there are marked as replaced.

Each deployment records the CPU and memory it runs with, as committed, from the blueprint's settings, and a fingerprint of the environment's values.

## Stop and Apply now

The application's and the environment's pages show what runs now, under **Running now**:

- **Apply now** runs the same version again, so it starts with the environment's values as they are now. Values reach an application only when it starts, and the page says when what runs has older ones. It doesn't wait for approval, as it runs a version that's already running; production's values themselves need its name and a reason to change.
- **Stop** removes the application from the environment: the platform removes its folder, and its line in the repository's root list, and the stop has succeeded once Flux applied that and the agent no longer reports its workload. Production needs its name and a reason. A stop can't be rolled back: deploy a version to run one again. What runs of an archived application can still be stopped.

Both are deployments, with an `action` of `apply` or `stop`, so they show in the history, one at a time like any other. If a stop fails, the version before is put back, as after any failed deployment.

## This machine

On an environment whose target is This machine, the platform runs each application itself, on the Docker of the machine that runs DreamDevOps, in the background:

1. **Check the signature:** it reads the image's signature back from the registry and checks it with the company's key, as a target would. Without a valid one, nothing is pulled.
2. **Pull the image** by digest, only from the platform's registry, with the bot's account in a throwaway Docker configuration.
3. **Start the new version** with the environment's variables, its secrets, read with a short-lived OpenBao token, and the platform's own values. They reach Docker through an env file only the API's user can read, removed at once, so no value appears in a command's arguments. The version before is kept, stopped.
4. **Wait until it's healthy**, up to `DEPLOY_HEALTH_TIMEOUT_SECONDS`. If it isn't, it's removed, and the version before runs again.

Each application gets one container and its own network, named after the application and environment, and a port on `LOCAL_HOSTING_BIND_ADDRESS`, kept from one version to the next, so its address stays the same. Containers run hardened: no Linux capabilities, no privilege escalation, 512 MiB of memory, one CPU and 256 processes at most, recorded as the deployment's limits. This machine runs one copy of each application, so it takes rolling and recreate deployments, not blue/green. A temporary problem, such as Docker restarting, runs the deployment again from the start.

This machine is for trying things out. Every company's applications share the machine that runs DreamDevOps, and they run code from the company's own developers, so `LOCAL_HOSTING` is off by default in production. The runtime is `infrastructure/local-docker-runtime.ts`, behind the `HostRuntime` port.

## Strategies

| Strategy | How it runs | Abort | Roll back |
|---|---|---|---|
| Recreate | A plain Deployment: the old pods stop, then the new ones start | Not possible; roll back instead | Recreates the earlier version |
| Rolling | An Argo Rollout that replaces pods a few at a time | Returns to the stable version | Rolls the earlier version out |
| Blue/green | An Argo Rollout that starts the new version on a preview service, and waits | Keeps traffic on the stable version | Starts the earlier version and switches traffic as soon as it's ready |

The first blue/green deployment of an application, or the first after another strategy, switches traffic straight away, because there is nothing to compare with. The old version stays up for ten minutes after a switch.

Canary and A/B are progressive deployments, a Commercial Edition feature. Without it, they are refused with `403`; with it, they are refused as not available yet.

## When a rollout goes wrong

- A rollout that degrades, such as one that never becomes ready, fails.
- An aborted rollout ends with traffic on the previous version.
- After either, the platform commits the last version that ran well back to Git, so Flux keeps it running. If nothing ran before, the application's folder is removed.
- A rollout that hasn't moved for 15 minutes fails.

Each deployment is a new revision, even of the same version, so a retry never inherits a failed rollout's state.

## Routes

All routes start with `/api/v1`.

| Route | Who | Purpose |
|---|---|---|
| `GET /company/deployments?application=&environment=` | Any member | The newest 50 deployments, with their progress |
| `GET /company/deployments/:id` | Any member | One deployment |
| `POST /company/applications/:id/deployments` | Deploy permission for the environment's kind | Deploys `{ "environment", "version", "strategy" }` |
| `POST /company/deployments/:id/approve`, `/reject` | `deployments-production:run`, not the requester | Decides a production deployment |
| `POST /company/deployments/:id/promote` | Deploy permission | Switches traffic to a waiting blue/green version |
| `POST /company/deployments/:id/abort` | Deploy permission | Stops a rolling or blue/green rollout |
| `POST /company/deployments/:id/rollback` | Deploy permission | Deploys the last version that ran well before this one. Production also needs a reason. |
| `GET /company/running?application=&environment=` | Any member | What runs now, with its limits and whether the environment's values changed since |
| `POST /company/applications/:id/apply` | Deploy permission | Runs what runs in `{ "environment" }` again, with the values as they are now |
| `POST /company/applications/:id/stop` | Deploy permission | Removes what runs in `{ "environment" }`. Production also needs a reason. |

Changes to production carry `confirmation`, its name, and `reason`.
| `POST /agent/heartbeat` | The agent's access token | Takes the agent's report, and returns promote and abort commands |
| `POST /agent/commands/:id` | The agent's access token | How a command went |

## Events

`DeploymentRequested`, `DeploymentApproved`, `DeploymentRejected`, `DeploymentStarted`, `DeploymentPromoted`, `DeploymentAbortRequested`, `DeploymentSucceeded`, `DeploymentFailed` and `DeploymentAborted` are recorded in the audit log. Company Admins can be notified of deployments starting or waiting for approval, being rejected, finishing, failing and being aborted.

## Not done yet

- **Canary and A/B:** they need a traffic router and automatic analysis.
- **Application traffic from outside:** applications get a cluster service; a public route per environment comes later.
- **Other places to run:** Docker hosts over SSH and cloud accounts are in the provider list, but can't be chosen yet.
