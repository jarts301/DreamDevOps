#!/bin/sh
# Restores a backup into scratch databases and a temporary folder, then checks the
# contents. The live databases and Forgejo files are never touched.
set -eu

. /ops/common.sh

backup=$(select_backup)
echo "Testing backup: $backup"

scratch_platform=restore_check_dreamdevops
scratch_keycloak=restore_check_keycloak
scratch_forgejo=restore_check_forgejo
scratch_files=$(mktemp -d)

cleanup() {
  dropdb --if-exists "$scratch_platform" || true
  dropdb --if-exists "$scratch_keycloak" || true
  dropdb --if-exists "$scratch_forgejo" || true
  rm -rf "$scratch_files"
}
trap cleanup EXIT

for pair in "$scratch_platform:dreamdevops" "$scratch_keycloak:keycloak" "$scratch_forgejo:forgejo"; do
  scratch=${pair%%:*}
  source_db=${pair##*:}
  dropdb --if-exists "$scratch"
  createdb "$scratch"
  pg_restore --no-owner --exit-on-error -d "$scratch" "/backups/$backup/$source_db.dump"
done

realms=$(psql -Atc 'select count(*) from realm' "$scratch_keycloak")
users=$(psql -Atc 'select count(*) from "user"' "$scratch_forgejo")
[ "$realms" -ge 1 ] || { echo "FAIL  Keycloak backup has no realms"; exit 1; }
[ "$users" -ge 1 ] || { echo "FAIL  Forgejo backup has no users"; exit 1; }
if [ "$(psql -Atc "select to_regclass('kernel.outbox') is not null" "$scratch_platform")" = "t" ]; then
  events=$(psql -Atc 'select count(*) from kernel.outbox' "$scratch_platform")
  echo "PASS  DreamDevOps database restored, with $events outbox event(s)"
else
  echo "PASS  DreamDevOps database restored, with no migrations applied yet"
fi
echo "PASS  Keycloak database restored, with $realms realm(s)"
echo "PASS  Forgejo database restored, with $users user(s)"

tar -xzf "/backups/$backup/forgejo-data.tar.gz" -C "$scratch_files"
[ -s "$scratch_files/gitea/conf/app.ini" ] || { echo "FAIL  Forgejo archive has no configuration"; exit 1; }
echo "PASS  Forgejo files restored"

echo "Restore test passed."
