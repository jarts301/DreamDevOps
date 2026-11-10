#!/bin/sh
# Checks that each tool is running and accepts the configured administrator login.
set -u

failures=0

check() {
  name=$1
  shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS  $name"
  else
    echo "FAIL  $name"
    failures=$((failures + 1))
  fi
}

basic_auth=$(printf '%s:%s' "$FORGEJO_ADMIN_USERNAME" "$FORGEJO_ADMIN_PASSWORD" | base64 | tr -d '\n')

forgejo_login() {
  wget -qO- --header "Authorization: Basic $basic_auth" http://forgejo:3000/api/v1/user \
    | grep -q "\"login\":\"$FORGEJO_ADMIN_USERNAME\""
}

forgejo_rejects_bad_login() {
  ! wget -qO- --header "Authorization: Basic bm90LWEtdXNlcjpub3QtYS1wYXNzd29yZA==" http://forgejo:3000/api/v1/user
}

keycloak_login() {
  wget -qO- \
    --post-data "grant_type=password&client_id=admin-cli&username=$KEYCLOAK_ADMIN_USERNAME&password=$KEYCLOAK_ADMIN_PASSWORD" \
    http://keycloak:8080/realms/master/protocol/openid-connect/token \
    | grep -q '"access_token"'
}

keycloak_rejects_bad_login() {
  ! wget -qO- \
    --post-data "grant_type=password&client_id=admin-cli&username=not-a-user&password=not-a-password" \
    http://keycloak:8080/realms/master/protocol/openid-connect/token
}

roles_are_isolated() {
  [ "$(psql -Atc "select has_database_privilege('forgejo', 'keycloak', 'connect')" postgres)" = "f" ] \
    && [ "$(psql -Atc "select has_database_privilege('keycloak', 'forgejo', 'connect')" postgres)" = "f" ]
}

platform_roles_are_restricted() {
  [ "$(psql -Atc "select count(*) from pg_roles where rolname like 'dreamdevops\_%' and not rolsuper and not rolbypassrls" postgres)" = "4" ]
}

# Forgejo hands sign-ins to Keycloak at its public address, with its own client and
# PKCE, which Keycloak requires.
forgejo_signs_in_through_keycloak() {
  location=$(wget -S -O /dev/null http://forgejo:3000/user/oauth2/keycloak 2>&1 | grep 'Location:')
  echo "$location" | grep -q 'Location: http://localhost:[0-9]*/realms/dreamdevops/protocol/openid-connect/auth?client_id=dreamdevops-forgejo' &&
    echo "$location" | grep -q 'code_challenge_method=S256'
}

platform_database_exists() {
  psql -Atc 'select 1' dreamdevops
}

check "PostgreSQL accepts connections" pg_isready -h postgres
check "DreamDevOps database exists" platform_database_exists
check "DreamDevOps roles can't bypass row-level security" platform_roles_are_restricted
check "Tool database roles cannot reach each other's data" roles_are_isolated
check "Forgejo is healthy" wget -qO- http://forgejo:3000/api/healthz
check "Forgejo accepts the administrator login" forgejo_login
check "Forgejo rejects a bad login" forgejo_rejects_bad_login
check "Keycloak is ready" wget -qO- http://keycloak:9000/health/ready
check "Keycloak accepts the administrator login" keycloak_login
check "Keycloak rejects a bad login" keycloak_rejects_bad_login
check "Forgejo signs people in through Keycloak" forgejo_signs_in_through_keycloak

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed."
  exit 1
fi
echo "All checks passed."
