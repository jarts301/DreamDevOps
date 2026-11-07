#!/bin/bash
# Creates the Forgejo login client in the dreamdevops realm, or brings it up to date.
# The realm file is only imported when the realm doesn't exist, so this also covers
# older local stacks. Safe to run repeatedly.
set -euo pipefail

kcadm=/opt/keycloak/bin/kcadm.sh
realm=dreamdevops
client_id=dreamdevops-forgejo

"$kcadm" config credentials \
  --server http://keycloak:8080 \
  --realm master \
  --user "$KEYCLOAK_ADMIN_USERNAME" \
  --password "$KEYCLOAK_ADMIN_PASSWORD" >/dev/null

# Forgejo sends PKCE, so Keycloak requires it as well as the secret.
settings=(
  -s clientId="$client_id"
  -s name=Forgejo
  -s enabled=true
  -s protocol=openid-connect
  -s publicClient=false
  -s secret="$FORGEJO_KEYCLOAK_CLIENT_SECRET"
  -s standardFlowEnabled=true
  -s directAccessGrantsEnabled=false
  -s implicitFlowEnabled=false
  -s 'redirectUris=["'"$FORGEJO_PUBLIC_URL"'/user/oauth2/keycloak/callback"]'
  -s 'attributes."pkce.code.challenge.method"=S256'
)

id=$("$kcadm" get clients -r "$realm" -q clientId="$client_id" --fields id --format csv --noquotes)
if [ -n "$id" ]; then
  "$kcadm" update "clients/$id" -r "$realm" "${settings[@]}"
  echo "Keycloak client for Forgejo is up to date."
else
  "$kcadm" create clients -r "$realm" "${settings[@]}" >/dev/null
  echo "Keycloak client for Forgejo created."
fi
