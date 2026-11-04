#!/bin/sh
# Runs once, when the PostgreSQL volume is first created.
# Each tool gets its own role and database, so neither can read the other's data.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v keycloak_password="$KEYCLOAK_DB_PASSWORD" \
  -v forgejo_password="$FORGEJO_DB_PASSWORD" <<'SQL'
CREATE ROLE keycloak LOGIN PASSWORD :'keycloak_password';
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;

CREATE ROLE forgejo LOGIN PASSWORD :'forgejo_password';
CREATE DATABASE forgejo OWNER forgejo;
REVOKE ALL ON DATABASE forgejo FROM PUBLIC;
SQL
