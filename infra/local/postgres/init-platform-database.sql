-- Creates the DreamDevOps database and its roles. Safe to run repeatedly.
-- Roles have no superuser or BYPASSRLS rights, so row-level security applies to them.
--
--   dreamdevops_owner  Runs migrations and owns the tables.
--   dreamdevops_app    Used by the application. Sees one company at a time.
--   dreamdevops_relay  Used by the outbox relay. Reads events across companies.
--   dreamdevops_jobs   Used by the job queue. Owns only the pgboss schema.
--
-- And one role per bounded context, such as dreamdevops_catalog, which can't log in. Each
-- has rights on its own context's schema only, which migrations grant. The application
-- switches to a context's role for that context's work, so the database refuses a query
-- that strays into another context's tables. See ARCHITECTURE.md.

\set ON_ERROR_STOP on

SELECT format('CREATE ROLE %I LOGIN', role_name)
FROM unnest(ARRAY['dreamdevops_owner', 'dreamdevops_app', 'dreamdevops_relay', 'dreamdevops_jobs']) AS role_name
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name)
\gexec

ALTER ROLE dreamdevops_owner PASSWORD :'owner_password';
ALTER ROLE dreamdevops_app PASSWORD :'app_password';
ALTER ROLE dreamdevops_relay PASSWORD :'relay_password';
ALTER ROLE dreamdevops_jobs PASSWORD :'jobs_password';

SELECT 'CREATE DATABASE dreamdevops OWNER dreamdevops_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'dreamdevops')
\gexec

REVOKE ALL ON DATABASE dreamdevops FROM PUBLIC;
GRANT CONNECT ON DATABASE dreamdevops TO dreamdevops_app, dreamdevops_relay, dreamdevops_jobs;
GRANT CREATE ON DATABASE dreamdevops TO dreamdevops_jobs;

-- The bounded contexts' roles, one per schema.
SELECT format('CREATE ROLE %I NOLOGIN', role_name)
FROM unnest(ARRAY[
  'dreamdevops_identity', 'dreamdevops_tenancy', 'dreamdevops_audit', 'dreamdevops_notification',
  'dreamdevops_editions', 'dreamdevops_catalog', 'dreamdevops_source', 'dreamdevops_webhooks',
  'dreamdevops_builds', 'dreamdevops_releases', 'dreamdevops_environments', 'dreamdevops_deployments',
  'dreamdevops_alerts'
]) AS role_name
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name)
\gexec

-- The application may switch to each, with SET ROLE, but doesn't inherit their rights, so
-- it can do nothing in a context's schema without saying which context it's working for.
GRANT dreamdevops_identity, dreamdevops_tenancy, dreamdevops_audit, dreamdevops_notification,
  dreamdevops_editions, dreamdevops_catalog, dreamdevops_source, dreamdevops_webhooks,
  dreamdevops_builds, dreamdevops_releases, dreamdevops_environments, dreamdevops_deployments,
  dreamdevops_alerts
  TO dreamdevops_app WITH INHERIT FALSE, SET TRUE;
