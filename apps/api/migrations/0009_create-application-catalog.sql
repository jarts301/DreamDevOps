-- Up Migration

CREATE SCHEMA catalog;

-- The kinds of application a company can register. A type is data, not code: the
-- Blueprint library later attaches versioned scaffolds to each one. This is platform
-- data shared by every company, so it isn't limited by row-level security.
CREATE TABLE catalog.application_types (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9-]{1,39}$'),
  name text NOT NULL,
  description text NOT NULL,
  available boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
);

INSERT INTO catalog.application_types (key, name, description, sort_order) VALUES
  ('restful-service', 'RESTful Service', 'An HTTP API, such as the backend of a web or mobile app', 10),
  ('web-frontend', 'Web Frontend', 'An application that runs in the browser, such as a single-page app', 20);

-- Each company's applications. Applications are archived, never deleted, so their
-- history and short names stay reserved.
CREATE TABLE catalog.applications (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  -- Fixed at registration, because it will name the application's repository.
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$'),
  type_key text NOT NULL REFERENCES catalog.application_types (key),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  status text NOT NULL CHECK (status IN ('active', 'archived')),
  created_by uuid REFERENCES identity.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (company_id, slug)
);

CREATE UNIQUE INDEX applications_name_idx ON catalog.applications (company_id, lower(name));

ALTER TABLE catalog.applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.applications FORCE ROW LEVEL SECURITY;

CREATE POLICY applications_company_isolation ON catalog.applications
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

-- The function below runs as the owner, which row-level security also limits. It may
-- only read, and only the current company.
CREATE POLICY applications_owner_read ON catalog.applications
  FOR SELECT
  TO dreamdevops_owner
  USING (company_id = kernel.current_company_id());

-- The current company's applications, with the name of whoever registered each one.
-- The app role can't read the user table, so this function reads only those names.
CREATE FUNCTION catalog.applications_view()
RETURNS TABLE (
  id uuid,
  name text,
  slug text,
  type_key text,
  type_name text,
  description text,
  status text,
  created_at timestamptz,
  created_by uuid,
  creator_name text,
  archived_at timestamptz
)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT a.id, a.name, a.slug, a.type_key, t.name, a.description, a.status,
           a.created_at, a.created_by, u.display_name, a.archived_at
    FROM catalog.applications a
    JOIN catalog.application_types t ON t.key = a.type_key
    LEFT JOIN identity.users u ON u.id = a.created_by
    WHERE a.company_id = kernel.current_company_id();
  $$;

REVOKE ALL ON FUNCTION catalog.applications_view() FROM PUBLIC;

GRANT USAGE ON SCHEMA catalog TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION catalog.applications_view() TO dreamdevops_app;
GRANT SELECT ON catalog.application_types TO dreamdevops_app;
GRANT SELECT, INSERT, UPDATE (name, description, status, updated_at, archived_at) ON catalog.applications
  TO dreamdevops_app;

-- Down Migration

DROP SCHEMA catalog CASCADE;
