#!/bin/bash
# Creates the Forgejo login client in the dreamdevops realm, or brings it up to date.
# The realm file is only imported when the realm doesn't exist, so this also covers
# older local stacks. Safe to run repeatedly.
set -euo pipefail

kcadm=/opt/keycloak/bin/kcadm.sh
realm=dreamdevops
client_id=dreamdevops-forgejo

"$kcadm" config credentials \
  --server "${KEYCLOAK_URL:-http://keycloak:8080}" \
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

# Login with a second factor on request. The platform asks for "mfa" when someone who
# must use it signs in: platform admins, Company Admins and Tech Leads. Password alone is
# level 1, a one-time code is level 2, and Keycloak asks people to set one up first.
flow=browser-mfa
# Prints the ID of the step with this name in a flow. The image has no awk, so Bash reads the CSV.
execution_id() {
  "$kcadm" get "authentication/flows/$1/executions" -r "$realm" --fields id,displayName --format csv --noquotes     | while IFS=, read -r id name; do
        if [ "$name" = "$2" ]; then echo "$id"; break; fi
      done
}
# Sets a step's requirement and its place: steps run in order of priority, lowest first.
require() {
  local id
  id=$(execution_id "$1" "$2")
  [ -n "$id" ] || { echo "No step named $2 in $1." >&2; exit 1; }
  "$kcadm" update "authentication/flows/$1/executions" -r "$realm"     -b "{\"id\":\"$id\",\"requirement\":\"$3\",\"priority\":$4}"
}
add_level() {
  "$kcadm" create "authentication/flows/$flow-forms/executions/flow" -r "$realm"     -s "alias=$flow-level-$1" -s type=basic-flow -s provider=registration-page-form >/dev/null
  require "$flow-forms" "$flow-level-$1" CONDITIONAL "${1}0"
  "$kcadm" create "authentication/flows/$flow-level-$1/executions/execution" -r "$realm"     -s provider=conditional-level-of-authentication >/dev/null
  require "$flow-level-$1" "Condition - Level of Authentication" REQUIRED 10
  "$kcadm" create "authentication/executions/$(execution_id "$flow-level-$1" "Condition - Level of Authentication")/config"     -r "$realm" -s "alias=$flow-level-$1" -s "config.\"loa-condition-level\"=$1" -s "config.\"loa-max-age\"=$2" >/dev/null
  "$kcadm" create "authentication/flows/$flow-level-$1/executions/execution" -r "$realm" -s "provider=$3" >/dev/null
  require "$flow-level-$1" "$4" REQUIRED 20
}

existing=$("$kcadm" get authentication/flows -r "$realm" --fields id,alias --format csv --noquotes   | while IFS=, read -r id alias; do
      if [ "$alias" = "$flow" ]; then echo "$id"; break; fi
    done)
# A flow made before steps had priorities, or left half-made, is made again.
first_step=$("$kcadm" get "authentication/flows/$flow/executions" -r "$realm" --fields displayName,priority --format csv --noquotes 2>/dev/null | head -n 1 || true)
if [ -n "$existing" ] && { [ -z "$(execution_id "$flow" "OTP Form")" ] || [ "$first_step" != "Cookie,10" ]; }; then
  "$kcadm" update "realms/$realm" -s browserFlow=browser
  "$kcadm" delete "authentication/flows/$existing" -r "$realm"
  existing=""
fi
if [ -n "$existing" ]; then
  echo "The login flow with a second factor already exists."
else
  "$kcadm" create authentication/flows -r "$realm" -s "alias=$flow" -s providerId=basic-flow \
    -s topLevel=true -s builtIn=false -s "description=Password, and a one-time code when asked for" >/dev/null
  "$kcadm" create "authentication/flows/$flow/executions/execution" -r "$realm" -s provider=auth-cookie >/dev/null
  require "$flow" Cookie ALTERNATIVE 10
  "$kcadm" create "authentication/flows/$flow/executions/flow" -r "$realm" \
    -s "alias=$flow-forms" -s type=basic-flow -s provider=registration-page-form >/dev/null
  require "$flow" "$flow-forms" ALTERNATIVE 20
  # Level 1 stays valid for 10 hours; level 2 is asked for at every login that needs it.
  add_level 1 36000 auth-username-password-form "Username Password Form"
  add_level 2 0 auth-otp-form "OTP Form"
  echo "The login flow with a second factor was created."
fi
# The level map is stored as a JSON string, so its quotes are escaped.
"$kcadm" update "realms/$realm" -s "browserFlow=$flow" -s 'attributes."acr.loa.map"="{\"password\":1,\"mfa\":2}"'
echo "Keycloak asks for a second factor when the platform requests it."
