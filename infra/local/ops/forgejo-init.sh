#!/bin/sh
# Creates the first Forgejo administrator and the platform bot if they don't exist yet.
# Safe to run repeatedly.
set -eu

config=/data/gitea/conf/app.ini

user_exists() {
  forgejo admin user list --config "$config" | awk 'NR > 1 { print $2 }' | grep -qx "$1"
}

if user_exists "$FORGEJO_ADMIN_USERNAME"; then
  echo "Forgejo administrator already exists."
else
  forgejo admin user create \
    --config "$config" \
    --admin \
    --username "$FORGEJO_ADMIN_USERNAME" \
    --password "$FORGEJO_ADMIN_PASSWORD" \
    --email "$FORGEJO_ADMIN_EMAIL" \
    --must-change-password=false
  echo "Forgejo administrator created."
fi

# The bot creates each company's organization. It isn't an administrator, and it's the
# only account allowed to create organizations.
if user_exists "$FORGEJO_BOT_USERNAME"; then
  echo "Forgejo platform bot already exists."
else
  forgejo admin user create \
    --config "$config" \
    --username "$FORGEJO_BOT_USERNAME" \
    --password "$FORGEJO_BOT_PASSWORD" \
    --email "$FORGEJO_BOT_EMAIL" \
    --must-change-password=false
  echo "Forgejo platform bot created."
fi

curl -fsS -o /dev/null -X PATCH \
  -u "$FORGEJO_ADMIN_USERNAME:$FORGEJO_ADMIN_PASSWORD" \
  -H 'Content-Type: application/json' \
  -d "{\"login_name\": \"$FORGEJO_BOT_USERNAME\", \"source_id\": 0, \"allow_create_organization\": true, \"admin\": false}" \
  "http://forgejo:3000/api/v1/admin/users/$FORGEJO_BOT_USERNAME"
echo "Forgejo platform bot may create organizations."
