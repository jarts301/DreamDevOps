# Deployment Orchestration

Runs versions of applications in environments. A deployment is a commit to the environment's own Git repository; the target's Flux applies it, Argo Rollouts runs it, and the agent reports how it goes. So every target behaves the same way, and Git keeps the history of what ran.

## A deployment, step by step

1. Someone picks a version, an environment and a strategy on the application's page.
2. The platform checks the request:
   - **Who:** Developers, Tech Leads and Operators deploy to test; Tech Leads and Operators to production.
   - **What:** the version passed every check, and the environment accepts its kind. Production takes final versions only, and test environments take feature images only if they accept them.
   - **Where:** the environment's target is connected.
   - **One at a time:** only one deployment of an application to an environment can be under way.
3. If the environment requires approval, which only production can, a second Tech Lead or Operator approves or rejects it. Nobody approves their own deployment.
4. The platform renders the application's manifests and commits them to the environment repository, under `apps/<application>/`. It fills in the environment's variables, where its secrets are, the blueprint's port, health checks and resources, and the image by digest.
5. Flux in the target applies the commit. The agent reports the rollout with each heartbeat, and the dashboard shows each step: saved to Git, applied by the target, rolling out with how many pods are ready, and for blue/green, the traffic switch.
6. When the rollout is healthy, the deployment has succeeded, and earlier ones of the same application there are marked as replaced.

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
| `POST /company/deployments/:id/rollback` | Deploy permission | Deploys the last version that ran well before this one |
| `POST /agent/heartbeat` | The agent's access token | Takes the agent's report, and returns promote and abort commands |
| `POST /agent/commands/:id` | The agent's access token | How a command went |

## Events

`DeploymentRequested`, `DeploymentApproved`, `DeploymentRejected`, `DeploymentStarted`, `DeploymentPromoted`, `DeploymentAbortRequested`, `DeploymentSucceeded`, `DeploymentFailed` and `DeploymentAborted` are recorded in the audit log. Company Admins can be notified of deployments starting or waiting for approval, being rejected, finishing, failing and being aborted.

## Not done yet

- **Canary and A/B:** they need a traffic router and automatic analysis.
- **Application traffic from outside:** applications get a cluster service; a public route per environment comes later.
- **Removing an application from an environment:** not possible from the dashboard yet.
- **Values applied without a deployment:** changed variables and secrets apply at the next deployment.
