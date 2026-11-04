# Local development stack

Runs the shared tools DreamDevOps needs on your own machine, using Docker Desktop.

| Tool | Purpose | Address |
|---|---|---|
| PostgreSQL | Databases for Keycloak and Forgejo | `localhost:5433` |
| Keycloak | Login provider | <http://localhost:8081> |
| Forgejo | Git hosting | <http://localhost:3000>, SSH on `localhost:2222` |

All ports bind to `127.0.0.1`, so other machines can't reach them. You can change the ports and passwords in `.env`.

## First run

Run these commands from this folder. Copy the settings file once:

```bash
cp .env.example .env
```

Then start the stack. The command returns once everything is ready, which takes about a minute the first time:

```bash
docker compose run --rm start
```

## Everyday commands

| Task | Command |
|---|---|
| Start and wait until ready | `docker compose run --rm start` |
| Check that everything works | `docker compose run --rm smoke-test` |
| Stop, keeping your data | `docker compose down` |
| See status | `docker compose ps -a` |
| Read a tool's logs | `docker compose logs -f keycloak` |
| Delete all data and start clean | `docker compose down -v` |

## Backup and restore

Backups go into `backups/`, which Git ignores. Each one is a timestamped folder with both databases and Forgejo's files.

| Task | Command |
|---|---|
| Create a backup | `docker compose run --rm backup` |
| Prove the latest backup can be restored, without touching live data | `docker compose run --rm restore-test` |

Restoring replaces all local Keycloak and Forgejo data. To restore the latest backup, stop both tools first:

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
