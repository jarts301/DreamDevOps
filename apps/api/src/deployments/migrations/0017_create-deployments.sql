-- Up Migration

-- Tech Leads and Operators manage every environment's variables and secrets. Company
-- Admins manage test environments' only, so production values stay with the people who
-- run production.
INSERT INTO identity.role_permissions (role_key, permission) VALUES
  ('tech-lead', 'environment-config:manage'),
  ('operator', 'environment-config:manage'),
  ('company-admin', 'test-environment-config:manage'),
  ('tech-lead', 'test-environment-config:manage'),
  ('operator', 'test-environment-config:manage');

-- Each environment's variables, for all its applications, or one application when
-- application_id is set. An application's value replaces the environment's.
CREATE TABLE environments.variables (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  environment_id uuid NOT NULL REFERENCES environments.environments (id),
  application_id uuid REFERENCES catalog.applications (id),
  name text NOT NULL CHECK (name ~ '^[A-Z_][A-Z0-9_]{0,99}$'),
  value text NOT NULL CHECK (length(value) <= 4096),
  updated_by uuid REFERENCES identity.users (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX variables_name_idx ON environments.variables
  (environment_id, coalesce(application_id, '00000000-0000-0000-0000-000000000000'), name);

-- The names of each environment's secrets. Their values are only in OpenBao, and the
-- platform can't read them back.
CREATE TABLE environments.secrets (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  environment_id uuid NOT NULL REFERENCES environments.environments (id),
  application_id uuid REFERENCES catalog.applications (id),
  name text NOT NULL CHECK (name ~ '^[A-Z_][A-Z0-9_]{0,99}$'),
  updated_by uuid REFERENCES identity.users (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX secrets_name_idx ON environments.secrets
  (environment_id, coalesce(application_id, '00000000-0000-0000-0000-000000000000'), name);

CREATE SCHEMA deployments;

-- Each request to run a version of an application in an environment. The platform
-- commits it to the environment's repository; the target applies it, and its agent
-- reports how it goes.
CREATE TABLE deployments.deployments (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  environment_id uuid NOT NULL REFERENCES environments.environments (id),
  application_id uuid NOT NULL REFERENCES catalog.applications (id),
  build_id uuid NOT NULL REFERENCES builds.builds (id),
  strategy text NOT NULL CHECK (strategy IN ('recreate', 'rolling', 'blue-green', 'canary', 'a-b')),
  status text NOT NULL CHECK (status IN (
    'awaiting-approval', 'rejected', 'queued', 'committed', 'progressing', 'paused',
    'succeeded', 'failed', 'aborted', 'superseded')),
  -- The deployment this one rolls back, if it's a rollback.
  rollback_of uuid REFERENCES deployments.deployments (id),
  commit_sha text,
  -- How far the rollout got, as the agent last reported it.
  progress jsonb NOT NULL DEFAULT '{}',
  message text CHECK (length(message) <= 1000),
  requested_by uuid REFERENCES identity.users (id),
  approved_by uuid REFERENCES identity.users (id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX deployments_application_idx ON deployments.deployments (company_id, application_id, created_at DESC);
CREATE INDEX deployments_environment_idx ON deployments.deployments (company_id, environment_id, created_at DESC);
-- One running deployment per application and environment.
CREATE UNIQUE INDEX deployments_active_idx ON deployments.deployments (environment_id, application_id)
  WHERE status IN ('awaiting-approval', 'queued', 'committed', 'progressing', 'paused');

-- Promote and abort commands for an agent, which picks them up with its next heartbeat.
CREATE TABLE deployments.commands (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  deployment_id uuid NOT NULL REFERENCES deployments.deployments (id),
  environment_id uuid NOT NULL REFERENCES environments.environments (id),
  action text NOT NULL CHECK (action IN ('promote', 'abort')),
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'done', 'failed')),
  message text CHECK (length(message) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  item text[];
BEGIN
  FOREACH item SLICE 1 IN ARRAY ARRAY[
    ARRAY['environments', 'variables'], ARRAY['environments', 'secrets'],
    ARRAY['deployments', 'deployments'], ARRAY['deployments', 'commands']] LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', item[1], item[2]);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', item[1], item[2]);
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I TO dreamdevops_app
         USING (company_id = kernel.current_company_id())
         WITH CHECK (company_id = kernel.current_company_id())',
      item[2] || '_company_isolation', item[1], item[2]);
  END LOOP;
END $$;

-- Deployments that have gone quiet for too long, in every company, for the sweep.
CREATE POLICY deployments_owner_lookup ON deployments.deployments FOR SELECT TO dreamdevops_owner USING (true);
CREATE FUNCTION deployments.stalled_deployments(p_updated_before timestamptz)
RETURNS TABLE (deployment_id uuid, company_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT id, company_id FROM deployments.deployments
    WHERE status IN ('queued', 'committed', 'progressing') AND updated_at < p_updated_before
    LIMIT 100;
  $$;
REVOKE ALL ON FUNCTION deployments.stalled_deployments(timestamptz) FROM PUBLIC;

-- The current company's deployments, with the names of who asked and who approved. The
-- app role can't read the user table, so this function reads only those names.
CREATE POLICY deployments_owner_read ON deployments.deployments FOR SELECT TO dreamdevops_owner
  USING (company_id = kernel.current_company_id());
CREATE FUNCTION deployments.deployments_view()
RETURNS TABLE (
  id uuid,
  environment_id uuid,
  application_id uuid,
  build_id uuid,
  strategy text,
  status text,
  rollback_of uuid,
  commit_sha text,
  progress jsonb,
  message text,
  requested_by uuid,
  requester_name text,
  approved_by uuid,
  approver_name text,
  approved_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  finished_at timestamptz
)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT d.id, d.environment_id, d.application_id, d.build_id, d.strategy, d.status, d.rollback_of,
           d.commit_sha, d.progress, d.message, d.requested_by, r.display_name, d.approved_by,
           a.display_name, d.approved_at, d.created_at, d.updated_at, d.finished_at
    FROM deployments.deployments d
    LEFT JOIN identity.users r ON r.id = d.requested_by
    LEFT JOIN identity.users a ON a.id = d.approved_by
    WHERE d.company_id = kernel.current_company_id();
  $$;
REVOKE ALL ON FUNCTION deployments.deployments_view() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deployments.deployments_view() TO dreamdevops_app;

GRANT USAGE ON SCHEMA deployments TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION deployments.stalled_deployments(timestamptz) TO dreamdevops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON environments.variables, environments.secrets TO dreamdevops_app;
GRANT SELECT, INSERT, UPDATE ON deployments.deployments, deployments.commands TO dreamdevops_app;

-- Down Migration

DROP SCHEMA deployments CASCADE;
DROP TABLE environments.secrets;
DROP TABLE environments.variables;
DELETE FROM identity.role_permissions
WHERE permission IN ('environment-config:manage', 'test-environment-config:manage');
