-- Up Migration

-- The Application Catalog scaffold an application started from, such as "angular". Null
-- means its repository started empty, or that it was registered before scaffolds. Like
-- the type, the application role may set it when creating an application, but not change it.
ALTER TABLE tenancy.applications
  ADD COLUMN scaffold text CHECK (char_length(scaffold) <= 60 AND scaffold ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- What each application has in other tools, such as its Git repository, and how far along it is.
CREATE TABLE tenancy.application_resources (
  application_id uuid NOT NULL REFERENCES tenancy.applications (id),
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  kind text NOT NULL CHECK (kind IN ('git-repository')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed', 'erased')),
  external_name text,
  url text,
  -- Safe to show to the company's members. It never holds credentials.
  last_error text,
  attempts integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  PRIMARY KEY (application_id, kind)
);

-- Applications registered before repositories wait for someone to ask for theirs.
INSERT INTO tenancy.application_resources (application_id, company_id, kind, status)
SELECT a.id, a.company_id, 'git-repository', CASE WHEN c.status = 'erased' THEN 'erased' ELSE 'pending' END
FROM tenancy.applications a
JOIN tenancy.companies c ON c.id = a.company_id;

-- As with company resources, RLS isn't forced, so the erasure function, which runs as
-- the owner, can reach them. The application role is always limited to the current company.
ALTER TABLE tenancy.application_resources ENABLE ROW LEVEL SECURITY;

CREATE POLICY application_resources_company_isolation ON tenancy.application_resources
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

GRANT SELECT, INSERT, UPDATE (status, external_name, url, last_error, attempts, updated_at, ready_at)
  ON tenancy.application_resources TO dreamdevops_app;

-- The same as before, and the applications' repositories now wait to be erased too. Each
-- keeps its repository's name until then, taken before the slugs are replaced.
CREATE OR REPLACE FUNCTION tenancy.erase_current_company(p_erased_by uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
  AS $$
    DECLARE
      v_company uuid := kernel.current_company_id();
      v_slug text;
    BEGIN
      SELECT slug INTO v_slug FROM tenancy.companies WHERE id = v_company AND status = 'closed' FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Only a closed company can be erased.' USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;

      UPDATE tenancy.company_resources
      SET status = 'pending',
          external_name = coalesce(external_name, v_slug),
          url = NULL,
          last_error = NULL,
          attempts = 0,
          updated_at = now()
      WHERE company_id = v_company;

      UPDATE tenancy.application_resources r
      SET status = CASE WHEN r.status = 'erased' THEN 'erased' ELSE 'pending' END,
          external_name = CASE WHEN r.status = 'erased' THEN NULL ELSE coalesce(r.external_name, a.slug) END,
          url = NULL,
          last_error = NULL,
          attempts = 0,
          updated_at = now()
      FROM tenancy.applications a
      WHERE a.id = r.application_id AND r.company_id = v_company;

      UPDATE tenancy.applications
      SET slug = 'erased-' || replace(id::text, '-', ''),
          name = 'Erased application',
          description = '',
          status = 'archived',
          archived_at = coalesce(archived_at, now()),
          erased_at = now(),
          updated_at = now()
      WHERE company_id = v_company;

      UPDATE tenancy.companies
      SET slug = 'erased-' || replace(id::text, '-', ''),
          name = 'Erased company ' || left(id::text, 8),
          status = 'erased',
          status_changed_at = now(),
          erased_at = now(),
          erased_by = p_erased_by
      WHERE id = v_company;

      PERFORM identity.erase_current_company_invitations();
    END;
  $$;

-- Down Migration

CREATE OR REPLACE FUNCTION tenancy.erase_current_company(p_erased_by uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
  AS $$
    DECLARE
      v_company uuid := kernel.current_company_id();
      v_slug text;
    BEGIN
      SELECT slug INTO v_slug FROM tenancy.companies WHERE id = v_company AND status = 'closed' FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Only a closed company can be erased.' USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;

      UPDATE tenancy.company_resources
      SET status = 'pending',
          external_name = coalesce(external_name, v_slug),
          url = NULL,
          last_error = NULL,
          attempts = 0,
          updated_at = now()
      WHERE company_id = v_company;

      UPDATE tenancy.applications
      SET slug = 'erased-' || replace(id::text, '-', ''),
          name = 'Erased application',
          description = '',
          status = 'archived',
          archived_at = coalesce(archived_at, now()),
          erased_at = now(),
          updated_at = now()
      WHERE company_id = v_company;

      UPDATE tenancy.companies
      SET slug = 'erased-' || replace(id::text, '-', ''),
          name = 'Erased company ' || left(id::text, 8),
          status = 'erased',
          status_changed_at = now(),
          erased_at = now(),
          erased_by = p_erased_by
      WHERE id = v_company;

      PERFORM identity.erase_current_company_invitations();
    END;
  $$;

DROP TABLE tenancy.application_resources;
ALTER TABLE tenancy.applications DROP COLUMN scaffold;
