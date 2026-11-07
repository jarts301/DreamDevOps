-- Up Migration

CREATE SCHEMA source;

-- One repository per application, created in the background from its blueprint.
CREATE TABLE source.repositories (
  application_id uuid PRIMARY KEY REFERENCES catalog.applications (id),
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  organization text NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('creating', 'ready', 'failed')),
  -- The blueprint version is chosen once, so retries use the same scaffold.
  blueprint_key text,
  blueprint_version text,
  external_id text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE source.repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE source.repositories FORCE ROW LEVEL SECURITY;

CREATE POLICY repositories_company_isolation ON source.repositories
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

-- The current company's members, with their Keycloak user ID, which is also their Git
-- username, and their permissions. A suspended company has none, so its members lose
-- their Git access too.
CREATE FUNCTION source.member_accounts()
RETURNS TABLE (user_id uuid, username text, permissions text[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT u.id, u.subject,
           ARRAY(SELECT rp.permission FROM identity.role_permissions rp
                 WHERE rp.role_key = m.role_key ORDER BY rp.permission)
    FROM identity.memberships m
    JOIN identity.users u ON u.id = m.user_id
    JOIN tenancy.companies c ON c.id = m.company_id
    WHERE m.company_id = kernel.current_company_id() AND c.status <> 'suspended'
    ORDER BY u.id;
  $$;

REVOKE ALL ON FUNCTION source.member_accounts() FROM PUBLIC;

GRANT USAGE ON SCHEMA source TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION source.member_accounts() TO dreamdevops_app;
GRANT SELECT, INSERT,
  UPDATE (status, blueprint_key, blueprint_version, external_id, attempts, last_error, updated_at)
  ON source.repositories TO dreamdevops_app;

-- Down Migration

DROP SCHEMA source CASCADE;
