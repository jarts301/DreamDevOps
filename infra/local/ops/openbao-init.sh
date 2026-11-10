#!/bin/sh
# Prepares OpenBao, where each environment's secrets live, then exits. Safe to run
# repeatedly, and needed after every restart, because OpenBao starts sealed.
#
# Local only: the unseal key and root token stay in a volume that only this script
# mounts. On servers, use auto-unseal with a cloud key service, and no stored root token.
set -eu

export BAO_ADDR=http://openbao:8200
keys=/keys/init.json

if ! bao status -format=json | grep -q '"initialized": true'; then
  bao operator init -key-shares=1 -key-threshold=1 -format=json > "$keys"
  chmod 600 "$keys"
  echo "OpenBao initialized."
fi
unseal_key=$(tr -d '\n ' < "$keys" | sed 's/.*"unseal_keys_b64":\["\([^"]*\)".*/\1/')
root_token=$(tr -d '\n ' < "$keys" | sed 's/.*"root_token":"\([^"]*\)".*/\1/')
if bao status -format=json | grep -q '"sealed": true'; then
  bao operator unseal "$unseal_key" > /dev/null
  echo "OpenBao unsealed."
fi
export BAO_TOKEN="$root_token"

# Secrets are kept at dreamdevops/<company>/<environment>/shared, and
# dreamdevops/<company>/<environment>/apps/<application>, with their history.
if ! bao secrets list -format=json | grep -q '"dreamdevops/"'; then
  bao secrets enable -path=dreamdevops -version=2 kv > /dev/null
  echo "OpenBao keeps secrets at dreamdevops/."
fi

# The platform writes and deletes secrets but never reads their values, and makes one
# read-only policy and short-lived tokens per environment for its target.
bao policy write dreamdevops-platform - > /dev/null <<'POLICY'
path "dreamdevops/data/*" {
  capabilities = ["create", "update", "patch", "delete"]
}
path "dreamdevops/metadata/*" {
  capabilities = ["delete"]
}
path "sys/policies/acl/target-*" {
  capabilities = ["create", "update", "read", "delete"]
}
path "auth/token/create/target" {
  capabilities = ["create", "update"]
}
path "auth/token/renew-self" {
  capabilities = ["update"]
}
POLICY

# Target tokens can only carry an environment's policy, and live at most two hours.
bao write auth/token/roles/target \
  allowed_policies_glob="target-*" disallowed_policies="root,dreamdevops-platform" \
  orphan=true renewable=false token_explicit_max_ttl=7200 > /dev/null

# The platform's token has the ID in OPENBAO_PLATFORM_TOKEN. It's periodic, so it
# stays valid while the API renews it.
if ! BAO_TOKEN="$OPENBAO_PLATFORM_TOKEN" bao token lookup > /dev/null 2>&1; then
  bao token create -id="$OPENBAO_PLATFORM_TOKEN" -policy=dreamdevops-platform -period=768h -orphan \
    -display-name=dreamdevops-platform > /dev/null
  echo "OpenBao has the platform's token."
fi
echo "OpenBao is ready."
