-- Up Migration

-- Erasing a company keeps its rows, so references and history stay whole, and replaces
-- everything in them that could identify the company, its applications or its people.
ALTER TABLE tenancy.companies DROP CONSTRAINT companies_status_check;
ALTER TABLE tenancy.companies ADD CONSTRAINT companies_status_check
  CHECK (status IN ('provisioning', 'active', 'suspended', 'closed', 'erased'));
ALTER TABLE tenancy.companies
  ADD COLUMN erased_at timestamptz,
  ADD COLUMN erased_by uuid REFERENCES identity.users (id);

-- For an erased company, pending and failed mean its resource is still to be erased.
ALTER TABLE tenancy.company_resources DROP CONSTRAINT company_resources_status_check;
ALTER TABLE tenancy.company_resources ADD CONSTRAINT company_resources_status_check
  CHECK (status IN ('pending', 'ready', 'failed', 'erased'));

ALTER TABLE tenancy.applications ADD COLUMN erased_at timestamptz;

-- Row-level security is forced on applications, even for their owner. Erasing runs as
-- the owner, so it may read and change them, but only in the current company's context.
CREATE POLICY applications_erasure_read ON tenancy.applications
  FOR SELECT TO dreamdevops_owner
  USING (company_id = kernel.current_company_id());

CREATE POLICY applications_erasure ON tenancy.applications
  FOR UPDATE TO dreamdevops_owner
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

-- Invitations hold the email addresses of people the company invited.
CREATE FUNCTION identity.erase_current_company_invitations() RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = ''
  AS $$
    UPDATE identity.invitations
    SET email = 'erased-' || id || '@erased.invalid',
        token_hash = 'erased-' || id,
        revoked_at = coalesce(revoked_at, now())
    WHERE company_id = kernel.current_company_id();
  $$;

-- Erases the current company's data, all at once. It refuses unless the company is
-- closed, so nothing else can be in the middle of using it. Resources in other tools
-- are erased afterwards in the background, and the old slug names them until then.
CREATE FUNCTION tenancy.erase_current_company(p_erased_by uuid) RETURNS void
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

-- The same as before, and when each company was erased. Once it is, a resource's old
-- name stays hidden while it waits to be erased.
DROP FUNCTION tenancy.platform_companies(uuid);
CREATE FUNCTION tenancy.platform_companies(p_company_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  slug text,
  name text,
  status text,
  created_at timestamptz,
  status_changed_at timestamptz,
  erased_at timestamptz,
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
      c.erased_at,
      (SELECT count(*)::integer FROM identity.memberships m WHERE m.company_id = c.id),
      (
        SELECT coalesce(
          jsonb_agg(
            jsonb_build_object(
              'kind', r.kind,
              'status', r.status,
              'name', CASE WHEN c.status = 'erased' THEN NULL ELSE r.external_name END,
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

REVOKE ALL ON FUNCTION identity.erase_current_company_invitations() FROM PUBLIC;
REVOKE ALL ON FUNCTION tenancy.erase_current_company(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION tenancy.platform_companies(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenancy.erase_current_company(uuid) TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION tenancy.platform_companies(uuid) TO dreamdevops_app;

-- Down Migration

-- Erased data can't come back, so erased companies stay closed.
DROP FUNCTION tenancy.erase_current_company(uuid);
DROP FUNCTION identity.erase_current_company_invitations();
DROP POLICY applications_erasure ON tenancy.applications;
DROP POLICY applications_erasure_read ON tenancy.applications;

DROP FUNCTION tenancy.platform_companies(uuid);
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
REVOKE ALL ON FUNCTION tenancy.platform_companies(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenancy.platform_companies(uuid) TO dreamdevops_app;

UPDATE tenancy.companies SET status = 'closed' WHERE status = 'erased';
UPDATE tenancy.company_resources SET status = 'failed' WHERE status = 'erased';
ALTER TABLE tenancy.applications DROP COLUMN erased_at;
ALTER TABLE tenancy.company_resources DROP CONSTRAINT company_resources_status_check;
ALTER TABLE tenancy.company_resources ADD CONSTRAINT company_resources_status_check
  CHECK (status IN ('pending', 'ready', 'failed'));
ALTER TABLE tenancy.companies DROP COLUMN erased_by, DROP COLUMN erased_at;
ALTER TABLE tenancy.companies DROP CONSTRAINT companies_status_check;
ALTER TABLE tenancy.companies ADD CONSTRAINT companies_status_check
  CHECK (status IN ('provisioning', 'active', 'suspended', 'closed'));
