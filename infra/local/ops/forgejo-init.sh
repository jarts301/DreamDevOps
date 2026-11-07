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

# Members sign in to Forgejo through Keycloak. Their Forgejo username is their Keycloak
# user ID, so the platform can find them, and no one can take a local account's name.
if forgejo admin auth list --config "$config" | awk 'NR > 1 { print $2 }' | grep -qx keycloak; then
  echo "Forgejo already signs in through Keycloak."
else
  forgejo admin auth add-oauth \
    --config "$config" \
    --name keycloak \
    --provider openidConnect \
    --key dreamdevops-forgejo \
    --secret "$FORGEJO_KEYCLOAK_CLIENT_SECRET" \
    --auto-discover-url http://keycloak:8080/realms/dreamdevops/.well-known/openid-configuration \
    --scopes "openid email profile" \
    --skip-local-2fa
  echo "Forgejo now signs in through Keycloak."
fi

# The local CI runner connects with a shared secret, made by runner-secret-init.
forgejo forgejo-cli actions register \
  --config "$config" \
  --secret-file /runner-secret/secret \
  --name local-runner \
  --labels docker
echo "Forgejo knows the local CI runner."

# The image runner only takes jobs with its secret label, which only the platform's
# pipeline uses.
forgejo forgejo-cli actions register \
  --config "$config" \
  --secret-file /runner-secret/image-secret \
  --name local-image-runner \
  --labels "$IMAGE_RUNNER_LABEL"
echo "Forgejo knows the local image runner."
