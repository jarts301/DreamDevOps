#!/bin/sh
# Replaces the live databases and Forgejo files with a backup.
set -eu

. /ops/common.sh

if [ "${RESTORE_CONFIRM:-}" != "yes" ]; then
  echo "This replaces all local Keycloak and Forgejo data. Set RESTORE_CONFIRM=yes to continue." >&2
  exit 1
fi

backup=$(select_backup)

for db in keycloak forgejo; do
  connections=$(psql -Atc "select count(*) from pg_stat_activity where datname = '$db'" postgres)
  if [ "$connections" -ne 0 ]; then
    echo "$db has $connections open connection(s). Run: docker compose stop keycloak forgejo" >&2
    exit 1
  fi
done

echo "Restoring backup: $backup"
for db in keycloak forgejo; do
  pg_restore --clean --if-exists --exit-on-error -d "$db" "/backups/$backup/$db.dump"
done

find /forgejo-data -mindepth 1 -delete
tar -xzpf "/backups/$backup/forgejo-data.tar.gz" -C /forgejo-data

echo "Restore finished. Run: docker compose run --rm start"
