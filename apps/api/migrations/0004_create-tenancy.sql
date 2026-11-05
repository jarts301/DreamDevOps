-- Up Migration

CREATE SCHEMA tenancy;

-- The registry of companies. A company's slug names its resources in other tools,
-- such as its Git organization, so it can't change and is never reused.
CREATE TABLE tenancy.companies (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE
    CHECK (char_length(slug) BETWEEN 2 AND 40 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  status text NOT NULL CHECK (status IN ('provisioning', 'active', 'suspended', 'closed')),
  created_by uuid REFERENCES identity.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  status_changed_at timestamptz NOT NULL DEFAULT now()
);

-- What each company needs in other tools before it can be used, and how far along it is.
CREATE TABLE tenancy.company_resources (
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  kind text NOT NULL CHECK (kind IN ('git-organization')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  external_name text,
  url text,
  -- Safe to show to a Platform Admin. It never holds credentials.
  last_error text,
  attempts integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  PRIMARY KEY (company_id, kind)
);

CREATE TABLE tenancy.applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  slug text NOT NULL
    CHECK (char_length(slug) BETWEEN 2 AND 40 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by uuid REFERENCES identity.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  -- Archived applications keep their slug, so it always means the same application.
  UNIQUE (company_id, slug)
);

-- Companies that existed before this module had only an ID. They keep working, with
-- a name based on that ID, and their Git organization waits for a Platform Admin to
-- start provisioning it.
INSERT INTO tenancy.companies (id, slug, name, status)
SELECT company_id, 'company-' || replace(company_id::text, '-', ''), 'Company ' || left(company_id::text, 8), 'active'
FROM (SELECT company_id FROM identity.memberships UNION SELECT company_id FROM identity.invitations) AS existing;

INSERT INTO tenancy.company_resources (company_id, kind)
SELECT id, 'git-organization' FROM tenancy.companies;

-- The foreign keys Identity and Access left for this module to add.
ALTER TABLE identity.memberships
  ADD CONSTRAINT memberships_company_id_fkey FOREIGN KEY (company_id) REFERENCES tenancy.companies (id);
ALTER TABLE identity.invitations
  ADD CONSTRAINT invitations_company_id_fkey FOREIGN KEY (company_id) REFERENCES tenancy.companies (id);

-- RLS isn't forced on the registry, so the Platform Admin functions below, which run
-- as the table owner, can list every company. The application role is always limited
-- to the current company.
ALTER TABLE tenancy.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.company_resources ENABLE ROW LEVEL SECURITY;

-- Applications are company data that nothing reads across companies, so RLS is forced.
ALTER TABLE tenancy.applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.applications FORCE ROW LEVEL SECURITY;

CREATE POLICY companies_company_isolation ON tenancy.companies
  TO dreamdevops_app
  USING (id = kernel.current_company_id())
  WITH CHECK (id = kernel.current_company_id());

CREATE POLICY company_resources_company_isolation ON tenancy.company_resources
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

CREATE POLICY applications_company_isolation ON tenancy.applications
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

-- Every company, or one, as a Platform Admin sees it: the registry and its resources,
-- and how many members it has, but none of its data.
CREATE FUNCTION tenancy.platform_companies(p_company_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  slug text,
  name text,
  status text,
  created_at timestamptz,
  status_changed_at timestamptz,
  member_count integer,
  resources jsonb
)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT
      c.id,
      c.slug,
      c.name,
      c.status,
      c.created_at,
      c.status_changed_at,
      (SELECT count(*)::integer FROM identity.memberships m WHERE m.company_id = c.id),
      (
        SELECT coalesce(
          jsonb_agg(
            jsonb_build_object(
              'kind', r.kind,
              'status', r.status,
              'name', r.external_name,
              'url', r.url,
              'lastError', r.last_error,
              'attempts', r.attempts,
              'updatedAt', r.updated_at
            )
            ORDER BY r.kind
          ),
          '[]'::jsonb
        )
        FROM tenancy.company_resources r
        WHERE r.company_id = c.id
      )
    FROM tenancy.companies c
    WHERE p_company_id IS NULL OR c.id = p_company_id
    ORDER BY c.created_at DESC, c.id;
  $$;

-- The status of the company this transaction acts for. Other modules use this rather
-- than reading the table. It runs as the caller, so row-level security still applies.
CREATE FUNCTION tenancy.current_company_status() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT status FROM tenancy.companies WHERE id = kernel.current_company_id() $$;

-- Only active companies grant access. Members of a company that is provisioning,
-- suspended or closed lose it on their next request, and keep their membership.
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
        WHERE m.user_id = u.id AND c.status = 'active'
      )
    )
    FROM identity.users u
    WHERE u.id = p_user_id;
  $$;

REVOKE ALL ON FUNCTION tenancy.platform_companies(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION tenancy.current_company_status() FROM PUBLIC;

GRANT USAGE ON SCHEMA tenancy TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION tenancy.platform_companies(uuid) TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION tenancy.current_company_status() TO dreamdevops_app;
-- The slug, and who created something, never change. Nothing is ever deleted.
GRANT SELECT, INSERT, UPDATE (name, status, status_changed_at) ON tenancy.companies TO dreamdevops_app;
GRANT SELECT, INSERT, UPDATE (status, external_name, url, last_error, attempts, updated_at, ready_at)
  ON tenancy.company_resources TO dreamdevops_app;
GRANT SELECT, INSERT, UPDATE (name, description, status, updated_at, archived_at)
  ON tenancy.applications TO dreamdevops_app;

-- Down Migration

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

ALTER TABLE identity.invitations DROP CONSTRAINT invitations_company_id_fkey;
ALTER TABLE identity.memberships DROP CONSTRAINT memberships_company_id_fkey;
DROP SCHEMA tenancy CASCADE;
