#!/bin/sh
# Creates the first Forgejo administrator if it does not exist yet.
set -eu

config=/data/gitea/conf/app.ini

if forgejo admin user list --admin --config "$config" | awk 'NR > 1 { print $2 }' | grep -qx "$FORGEJO_ADMIN_USERNAME"; then
  echo "Forgejo administrator already exists."
  exit 0
fi

forgejo admin user create \
  --config "$config" \
  --admin \
  --username "$FORGEJO_ADMIN_USERNAME" \
  --password "$FORGEJO_ADMIN_PASSWORD" \
  --email "$FORGEJO_ADMIN_EMAIL" \
  --must-change-password=false

echo "Forgejo administrator created."
