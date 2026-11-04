#!/bin/sh
# Writes one timestamped backup folder containing both databases and Forgejo's files.
# Keycloak keeps all its state in its database, so it has no separate file backup.
set -eu

name=$(date -u +%Y%m%dT%H%M%SZ)
partial="/backups/.partial-$name"
trap 'rm -rf "$partial"' EXIT
mkdir -p "$partial"

for db in keycloak forgejo; do
  echo "Dumping database: $db"
  pg_dump -Fc -d "$db" -f "$partial/$db.dump"
done

echo "Archiving Forgejo files"
tar -czf "$partial/forgejo-data.tar.gz" -C /forgejo-data .

# The rename means an interrupted run never looks like a finished backup.
mv "$partial" "/backups/$name"
trap - EXIT
echo "Backup written: $name"
