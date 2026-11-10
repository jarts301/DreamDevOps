# Deployment agent

Runs in each deployment target, a Kubernetes cluster. It proves itself to the platform with its own key, sets up the cluster for its environment, reports how deployments are doing, and runs promote and abort commands. It only makes outbound calls, so a cluster needs no open port for the platform.

It's TypeScript with no dependencies; Node runs it directly.

## What it does

1. **Registers once.** The dashboard's Helm command carries a one-time registration token. The agent makes an Ed25519 key pair, sends only the public key, and keeps the private key in a Secret in `dreamdevops-system`.
2. **Gets access tokens.** It signs a one-minute assertion with its key for each 15-minute access token.
3. **Registers a deploy key.** It makes an SSH key for Flux and sends its public half. The platform adds it to the environment's repository as a read-only deploy key.
4. **Sets up the cluster** from the configuration the platform gives it:
   - Flux reads the environment repository with the deploy key.
   - Flux installs Argo Rollouts, Kyverno and the External Secrets Operator at pinned versions, each as its own Helm release.
   - A Kyverno policy lets into the managed namespaces only images signed with the environment's trusted key: the release key in production, the test key elsewhere.
   - A secret store reads the environment's secrets from OpenBao, with a two-hour token limited to them.
   - Each managed namespace gets the company's read-only registry login.
5. **Reports every 30 seconds:** which commit Flux applied, and each deployed workload's phase and ready pods. With the answer come the commands to run.

It fetches its configuration again every 30 minutes, and before the secrets token runs out.

## Files

| File | Purpose |
|---|---|
| `src/main.ts` | The loop |
| `src/identity.ts` | Keys, assertions and the SSH deploy key |
| `src/platform.ts` | Calls to the platform |
| `src/kubernetes.ts` | A small Kubernetes client with server-side apply. It manages only the kinds it lists. |
| `src/cluster.ts` | The objects that set up the cluster |
| `src/components.ts` | The tools Flux installs, and their versions |
| `src/reports.ts` | Reads rollouts, deployments and Flux's status |
| `../../charts/dreamdevops-agent` | The Helm chart: the agent, its permissions and Flux |

## Publishing

On a local machine, with the target profile running:

```bash
npm run publish:local -w @dreamdevops/agent
```

It builds the image and pushes it to the local Forgejo as the bot, then packages the chart with Flux and pushes it to `oci://platform.internal:3000/dreamdevops-bot/charts/dreamdevops-agent`. Raise the version in `package.json` and `Chart.yaml` together.

## Tests

```bash
npm test -w @dreamdevops/agent
```

The platform's integration tests play the agent against the API; [the local stack's README](../../infra/local/README.md#the-local-target) shows how to run the real one in k3s.
