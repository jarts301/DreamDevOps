-- Up Migration

CREATE SCHEMA identity;

-- Users exist across companies, so the application role can't read this table.
-- It reaches users only through the functions below.
CREATE TABLE identity.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL UNIQUE,
  email text NOT NULL,
  email_verified boolean NOT NULL,
  display_name text NOT NULL,
  platform_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_email_idx ON identity.users (email);

-- Roles and their permissions are data, so companies can add custom roles later.
CREATE TABLE identity.roles (
  key text PRIMARY KEY,
  name text NOT NULL,
  -- Platform roles come from the login provider and can't be granted inside a company.
  is_company_role boolean NOT NULL
);

CREATE TABLE identity.role_permissions (
  role_key text NOT NULL REFERENCES identity.roles (key),
  permission text NOT NULL,
  PRIMARY KEY (role_key, permission)
);

INSERT INTO identity.roles (key, name, is_company_role) VALUES
  ('platform-admin', 'Platform Admin', false),
  ('company-admin', 'Company Admin', true),
  ('tech-lead', 'Tech Lead', true),
  ('developer', 'Developer', true),
  ('operator', 'Operator', true),
  ('viewer', 'Viewer', true);

INSERT INTO identity.role_permissions (role_key, permission) VALUES
  ('platform-admin', 'companies:manage'),
  ('platform-admin', 'audit:read-own'),
  ('company-admin', 'company-users:manage'),
  ('company-admin', 'targets:connect'),
  ('company-admin', 'applications:create'),
  ('company-admin', 'dashboards:view'),
  ('company-admin', 'audit:read'),
  ('tech-lead', 'applications:create'),
  ('tech-lead', 'code:push'),
  ('tech-lead', 'pull-requests:approve'),
  ('tech-lead', 'releases:start'),
  ('tech-lead', 'feature-images:build'),
  ('tech-lead', 'deployments-test:run'),
  ('tech-lead', 'deployments-production:run'),
  ('tech-lead', 'dashboards:view'),
  ('developer', 'code:push'),
  ('developer', 'feature-images:build'),
  ('developer', 'deployments-test:run'),
  ('developer', 'dashboards:view'),
  ('operator', 'targets:connect'),
  ('operator', 'deployments-test:run'),
  ('operator', 'deployments-production:run'),
  ('operator', 'dashboards:view'),
  ('viewer', 'dashboards:view');

-- Each user has one role per company. Companies have no table yet, because the
-- Tenancy module creates it and will add the foreign key on company_id.
CREATE TABLE identity.memberships (
  company_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES identity.users (id),
  role_key text NOT NULL REFERENCES identity.roles (key) CHECK (role_key <> 'platform-admin'),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);

CREATE INDEX memberships_user_idx ON identity.memberships (user_id);

CREATE TABLE identity.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  email text NOT NULL,
  role_key text NOT NULL REFERENCES identity.roles (key) CHECK (role_key <> 'platform-admin'),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES identity.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES identity.users (id),
  revoked_at timestamptz
);

-- Stops two usable invitations for one person in one company.
CREATE UNIQUE INDEX invitations_one_open_per_email_idx ON identity.invitations (company_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- RLS isn't forced here, so the functions below, which run as the table owner, can
-- find a user's companies at login, before any company is known. The application
-- role is always limited to the current company.
ALTER TABLE identity.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY memberships_company_isolation ON identity.memberships
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

CREATE POLICY invitations_company_isolation ON identity.invitations
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

CREATE FUNCTION identity.record_login(
  p_subject text,
  p_email text,
  p_email_verified boolean,
  p_display_name text,
  p_platform_admin boolean
) RETURNS uuid
  LANGUAGE sql SECURITY DEFINER SET search_path = ''
  AS $$
    INSERT INTO identity.users (subject, email, email_verified, display_name, platform_admin)
    VALUES (p_subject, p_email, p_email_verified, p_display_name, p_platform_admin)
    ON CONFLICT (subject) DO UPDATE SET
      email = EXCLUDED.email,
      email_verified = EXCLUDED.email_verified,
      display_name = EXCLUDED.display_name,
      platform_admin = EXCLUDED.platform_admin,
      last_login_at = now()
    RETURNING id;
  $$;

CREATE FUNCTION identity.user_access(p_user_id uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT jsonb_build_object(
      'userId', u.id,
      'subject', u.subject,
      'email', u.email,
      'emailVerified', u.email_verified,
      'displayName', u.display_name,
      'platformPermissions', CASE WHEN u.platform_admin THEN (
        SELECT coalesce(jsonb_agg(rp.permission ORDER BY rp.permission), '[]'::jsonb)
        FROM identity.role_permissions rp
        WHERE rp.role_key = 'platform-admin'
      ) ELSE '[]'::jsonb END,
      'memberships', (
        SELECT coalesce(
          jsonb_agg(
            jsonb_build_object(
              'companyId', m.company_id,
              'role', m.role_key,
              'permissions', (
                SELECT coalesce(jsonb_agg(rp.permission ORDER BY rp.permission), '[]'::jsonb)
                FROM identity.role_permissions rp
                WHERE rp.role_key = m.role_key
              )
            )
            ORDER BY m.joined_at, m.company_id
          ),
          '[]'::jsonb
        )
        FROM identity.memberships m
        WHERE m.user_id = u.id
      )
    )
    FROM identity.users u
    WHERE u.id = p_user_id;
  $$;

-- Member details for the current company only.
CREATE FUNCTION identity.company_members()
RETURNS TABLE (user_id uuid, email text, display_name text, role_key text, joined_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT u.id, u.email, u.display_name, m.role_key, m.joined_at
    FROM identity.memberships m
    JOIN identity.users u ON u.id = m.user_id
    WHERE m.company_id = kernel.current_company_id()
    ORDER BY m.joined_at, u.id;
  $$;

-- Finds which company an invitation belongs to. It needs the secret token's hash,
-- and the accepting user has no context in that company until this answers.
CREATE FUNCTION identity.invitation_company(p_token_hash text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT company_id FROM identity.invitations WHERE token_hash = p_token_hash;
  $$;

REVOKE ALL ON FUNCTION identity.record_login(text, text, boolean, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.user_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.company_members() FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.invitation_company(text) FROM PUBLIC;

GRANT USAGE ON SCHEMA identity TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION identity.record_login(text, text, boolean, text, boolean) TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION identity.user_access(uuid) TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION identity.company_members() TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION identity.invitation_company(text) TO dreamdevops_app;
GRANT SELECT ON identity.roles, identity.role_permissions TO dreamdevops_app;
GRANT SELECT, INSERT, DELETE, UPDATE (role_key) ON identity.memberships TO dreamdevops_app;
GRANT SELECT, INSERT, UPDATE (accepted_at, accepted_by, revoked_at) ON identity.invitations TO dreamdevops_app;

-- Down Migration

DROP SCHEMA identity CASCADE;
