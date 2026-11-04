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

check "PostgreSQL accepts connections" pg_isready -h postgres
check "Tool database roles cannot reach each other's data" roles_are_isolated
check "Forgejo is healthy" wget -qO- http://forgejo:3000/api/healthz
check "Forgejo accepts the administrator login" forgejo_login
check "Forgejo rejects a bad login" forgejo_rejects_bad_login
check "Keycloak is ready" wget -qO- http://keycloak:9000/health/ready
check "Keycloak accepts the administrator login" keycloak_login
check "Keycloak rejects a bad login" keycloak_rejects_bad_login

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed."
  exit 1
fi
echo "All checks passed."
