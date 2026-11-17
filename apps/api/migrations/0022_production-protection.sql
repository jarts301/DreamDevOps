-- Up Migration

-- Changing a production environment itself, such as renaming it, archiving it or
-- disconnecting its target, is for Tech Leads and Operators only. Company Admins keep
-- managing test environments.
INSERT INTO identity.role_permissions (role_key, permission) VALUES
  ('tech-lead', 'environments-production:manage'),
  ('operator', 'environments-production:manage');

ALTER TABLE deployments.deployments
  -- Why someone asked, as they typed it. Production needs one for anything but deploying.
  ADD COLUMN reason text CHECK (length(reason) BETWEEN 10 AND 500),
  -- What it does: run a version, remove what runs, or run the same version again so it
  -- starts with the environment's values as they are now.
  ADD COLUMN action text NOT NULL DEFAULT 'deploy' CHECK (action IN ('deploy', 'stop', 'apply')),
  -- The CPU and memory the version runs with, as committed, such as {"cpu": "250m", "memory": "256Mi"}.
  ADD COLUMN limits jsonb,
  -- A fingerprint of the environment's values as committed, so the platform can say when
  -- what runs has older settings than the environment has now.
  ADD COLUMN config_hash text CHECK (config_hash ~ '^[0-9a-f]{64}$');

DROP FUNCTION deployments.deployments_view();
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
  finished_at timestamptz,
  reason text,
  action text,
  limits jsonb,
  config_hash text
)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT d.id, d.environment_id, d.application_id, d.build_id, d.strategy, d.status, d.rollback_of,
           d.commit_sha, d.progress, d.message, d.requested_by, r.display_name, d.approved_by,
           a.display_name, d.approved_at, d.created_at, d.updated_at, d.finished_at,
           d.reason, d.action, d.limits, d.config_hash
    FROM deployments.deployments d
    LEFT JOIN identity.users r ON r.id = d.requested_by
    LEFT JOIN identity.users a ON a.id = d.approved_by
    WHERE d.company_id = kernel.current_company_id();
  $$;
REVOKE ALL ON FUNCTION deployments.deployments_view() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deployments.deployments_view() TO dreamdevops_app;

-- Down Migration

DROP FUNCTION deployments.deployments_view();
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
ALTER TABLE deployments.deployments DROP COLUMN config_hash, DROP COLUMN limits, DROP COLUMN action, DROP COLUMN reason;
DELETE FROM identity.role_permissions WHERE permission = 'environments-production:manage';
