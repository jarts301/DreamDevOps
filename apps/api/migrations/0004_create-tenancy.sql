-- Up Migration

CREATE SCHEMA tenancy;

-- The company register is platform data, not company data: it holds names and states,
-- which members and platform admins both need, so it isn't limited by row-level security.
CREATE TABLE tenancy.companies (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  -- Fixed at creation, because it names the company's resources, such as its Git organization.
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$'),
  status text NOT NULL CHECK (status IN ('provisioning', 'active', 'provisioning-failed', 'suspended')),
  created_by uuid REFERENCES identity.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  suspended_at timestamptz
);

CREATE UNIQUE INDEX companies_name_idx ON tenancy.companies (lower(name));

-- One row per resource a company needs, so provisioning can resume where it stopped.
CREATE TABLE tenancy.company_resources (
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  external_id text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, kind)
);

GRANT USAGE ON SCHEMA tenancy TO dreamdevops_app;
GRANT SELECT, INSERT, UPDATE (name, status, updated_at, suspended_at) ON tenancy.companies TO dreamdevops_app;
GRANT SELECT, INSERT, UPDATE (status, external_id, attempts, last_error, updated_at) ON tenancy.company_resources
  TO dreamdevops_app;

-- Memberships and invitations now point at real companies. NOT VALID keeps any rows
-- made before companies existed: they stay, but give no access, as the functions
-- below only return memberships of known companies.
ALTER TABLE identity.memberships
  ADD CONSTRAINT memberships_company_fk FOREIGN KEY (company_id) REFERENCES tenancy.companies (id) NOT VALID;
ALTER TABLE identity.invitations
  ADD CONSTRAINT invitations_company_fk FOREIGN KEY (company_id) REFERENCES tenancy.companies (id) NOT VALID;

-- A suspended company's memberships give no access, so suspension takes effect on
-- every member's next request. Company names are included for the dashboard.
CREATE OR REPLACE FUNCTION identity.user_access(p_user_id uuid) RETURNS jsonb
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
              'companyName', c.name,
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
        JOIN tenancy.companies c ON c.id = m.company_id
        WHERE m.user_id = u.id AND c.status <> 'suspended'
      )
    )
    FROM identity.users u
    WHERE u.id = p_user_id;
  $$;

-- Invitations to a suspended company can't be accepted.
CREATE OR REPLACE FUNCTION identity.invitation_company(p_token_hash text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT i.company_id
    FROM identity.invitations i
    JOIN tenancy.companies c ON c.id = i.company_id
    WHERE i.token_hash = p_token_hash AND c.status <> 'suspended';
  $$;

-- Down Migration

CREATE OR REPLACE FUNCTION identity.invitation_company(p_token_hash text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT company_id FROM identity.invitations WHERE token_hash = p_token_hash;
  $$;

CREATE OR REPLACE FUNCTION identity.user_access(p_user_id uuid) RETURNS jsonb
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

ALTER TABLE identity.invitations DROP CONSTRAINT invitations_company_fk;
ALTER TABLE identity.memberships DROP CONSTRAINT memberships_company_fk;
DROP SCHEMA tenancy CASCADE;
