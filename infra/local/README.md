# Local development stack

Runs the shared tools DreamDevOps needs on your own machine, using Docker Desktop.

| Tool | Purpose | Address |
|---|---|---|
| PostgreSQL | Databases for DreamDevOps, Keycloak and Forgejo | `localhost:5433` |
| Keycloak | Login provider, with the `dreamdevops` realm and sample users | <http://localhost:8081> |
| Forgejo | Git hosting, with a `dreamdevops-bot` user that creates each company's organization. People sign in through Keycloak. | <http://localhost:3000>, SSH on `localhost:2222` |
| Mailpit | Catches every email and shows it in a web page. Nothing is sent out. | <http://localhost:8025>, SMTP on `localhost:1025` |

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
