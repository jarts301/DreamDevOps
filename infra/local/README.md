# Local development stack

Runs the shared tools DreamDevOps needs on your own machine, using Docker Desktop.

| Tool | Purpose | Address |
|---|---|---|
| PostgreSQL | Databases for DreamDevOps, Keycloak and Forgejo | `localhost:5433` |
| Keycloak | Login provider, with the `dreamdevops` realm and sample users | <http://localhost:8081> |
| Forgejo | Git hosting, with a `dreamdevops-bot` user that creates each company's organization. People sign in through Keycloak. | <http://localhost:3000>, SSH on `localhost:2222` |
| Mailpit | Catches every email and shows it in a web page. Nothing is sent out. | <http://localhost:8025>, SMTP on `localhost:1025` |
| CI runners | Run Forgejo Actions jobs, each in a new unprivileged, short-lived container on their own Docker engine, which can't reach the other tools | Not reachable from outside |

All ports bind to `127.0.0.1`, so other machines can't reach them. Every password in `.env.example` is a fake dummy value, starting with `fake-dummy-`, and must never be used on a server. The tools keep the passwords they started with, so changing one in `.env` after the first run means changing it inside the tool too, or resetting with `docker compose down -v`, which deletes all local data.

## First run

Run these commands from this folder. Copy the settings file once:

```bash
cp .env.example .env
```

Then start the stack. The command returns once everything is ready, which takes about a minute the first time:

```bash
docker compose run --rm start
```

Then, from the repository root, install the dependencies and create the DreamDevOps tables:

```bash
npm install
```

```bash
npm run db:migrate
```

If you already had a `.env` file, copy any new values from `.env.example` into it first.

## Signing in to Forgejo

Forgejo signs people in through Keycloak, and creates their account on first sign-in. Its username is their Keycloak user ID, so nobody can choose a name that belongs to someone else, and a Keycloak login never attaches to an existing local account such as the bot's. Only the administrator and the bot sign in with a Forgejo password.

The `start` command sets this up and is safe to repeat: `keycloak-init` adds the `dreamdevops-forgejo` client to the realm, and `forgejo-init` adds Keycloak as Forgejo's login source. Keycloak always calls itself `http://localhost:8081`, so browsers and Forgejo agree on its address, while Forgejo reaches it inside Docker.

Forgejo reads Keycloak's settings when it starts, so it waits for Keycloak. When Docker restarts every container at once, Forgejo can still start first; its first Keycloak sign-in then goes without PKCE and fails. `forgejo-init` makes that first request itself, so running `start` after a restart repairs it, and the smoke test checks that PKCE is sent.

## The CI runners

Two runners share one Docker engine and run every company's pipeline jobs. On servers, each company should get its own runners and engine.

| Service | Purpose |
|---|---|
| `forgejo-runner` | Runs every job except image builds. Containers get `no-new-privileges`, Docker's default seccomp and AppArmor profiles, and limits of 2 CPUs, 4 GB of memory and 2,048 processes. |
| `forgejo-image-runner` | Runs only the image job, one at a time. Rootless BuildKit makes its own sandbox, so seccomp and AppArmor are relaxed here, and nowhere else. |
| `runner-docker` | The runners' Docker engine. Jobs run here, never on your machine's Docker. It needs privileged mode; the job containers inside it don't get it. |
| `runner-forgejo-proxy` | Forgejo calls itself `http://localhost:3000`, such as in its registry's sign-in address. This makes that address reach Forgejo inside the job networks too. |
| `runner-secret-init` | Makes the secrets the runners use to connect, once. They stay in a volume only Forgejo's setup and the runners mount. |

Jobs get no Docker socket, no volumes and no privileged mode. Each job runs in a new container that is removed when the job ends.

**What jobs can reach.** The runners and their engine sit on their own `ci` network, which only Forgejo shares. A firewall in the engine, [`ops/runner-firewall.sh`](ops/runner-firewall.sh), rejects job traffic to private addresses, so jobs can't reach PostgreSQL, Keycloak, Mailpit or ports on your machine. Jobs can reach:

- Forgejo, on port 3000.
- The API, at `http://host.docker.internal:4000`, and nothing else on your machine.
- The internet, to download tools and packages.

Forgejo's webhooks reach the API at the same address. The first pipeline run downloads the tool images and Trivy's vulnerability database, which takes a few minutes.

**The image runner's label.** Only the platform's pipeline uses the image runner. Its label, `IMAGE_RUNNER_LABEL`, is set in `.env`, and the API puts it in the pipeline it copies to each company. Use your own value outside this machine.

## Second factor

Platform admins, Company Admins and Tech Leads must sign in with a one-time code. `keycloak-init` adds a `browser-mfa` login flow: the password is level 1, and a one-time code is level 2. When the platform asks for level 2, Keycloak asks for a code, or asks the person to set up an authenticator app the first time. The sample users have no authenticator yet, so the first sign-in as `demo-platform-admin`, `demo-company-admin`, `demo-tech-lead` or `dev-platform-admin` asks to set one up.

## Demo users

`keycloak-init` also adds one demo user for each role, `demo-platform-admin`, `demo-company-admin`, `demo-tech-lead`, `demo-developer`, `demo-operator` and `demo-viewer`, all with the password in `KEYCLOAK_DEV_USER_PASSWORD`. Users that already exist are left alone, so authenticators survive restarts. It also removes the earlier `dev-company-admin` and `dev-developer`. The local API adds the demo users to Demo Company when it starts.

## Everyday commands

| Task | Command |
|---|---|
| Start and wait until ready | `docker compose run --rm start` |
| Check that everything works | `docker compose run --rm smoke-test` |
| Stop, keeping your data | `docker compose down` |
| See status | `docker compose ps -a` |
| Read a tool's logs | `docker compose logs -f keycloak` |
| Delete all data and start clean | `docker compose down -v` |

Keycloak imports its realm from `keycloak/dreamdevops-realm.json` only when the realm doesn't exist yet, so later changes to that file need `docker compose down -v`.

## Backup and restore

Backups go into `backups/`, which Git ignores. Each one is a timestamped folder with all three databases and Forgejo's files. Backups made before the DreamDevOps database existed can't be restored with these commands.

| Task | Command |
|---|---|
| Create a backup | `docker compose run --rm backup` |
| Prove the latest backup can be restored, without touching live data | `docker compose run --rm restore-test` |

Restoring replaces all local DreamDevOps, Keycloak and Forgejo data. To restore the latest backup, stop both tools and anything else using the database:

```bash
docker compose stop keycloak forgejo
```

Then run the restore with `RESTORE_CONFIRM` set in your shell. In PowerShell:

```powershell
$env:RESTORE_CONFIRM = "yes"; docker compose run --rm restore; Remove-Item Env:RESTORE_CONFIRM
```

In Bash:

```bash
RESTORE_CONFIRM=yes docker compose run --rm restore
```

Then start the stack again:

```bash
docker compose run --rm start
```

To use an older backup, set `BACKUP_NAME` to its folder name in the same way.

A backup taken while Forgejo is receiving pushes may catch a repository mid-write. Stop Forgejo first if you need an exact copy.

## Not included yet

This is the local version of the Platform infrastructure module. The proposal's server setup, k3s and TLS are not part of it. Other tools, such as OpenBao and the monitoring stack, get added with the modules that use them.
