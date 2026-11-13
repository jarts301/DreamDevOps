-- Up Migration

-- A type of application can start from several blueprints now, such as React, Vue or
-- Svelte for a web frontend, in TypeScript or JavaScript. Each application records the
-- one chosen when it was registered, by its key. Its repository starts from that
-- blueprint's newest version. Blueprints are files, not rows, so there's no foreign key.
ALTER TABLE catalog.applications
  ADD COLUMN blueprint_key text CHECK (blueprint_key ~ '^[a-z][a-z0-9-]{1,39}$');

-- Until now, each type had one blueprint, so every application started from it. Row-level
-- security hides every company's applications from the tables' owner, so it's lifted for
-- this update only, inside this migration's transaction.
ALTER TABLE catalog.applications NO FORCE ROW LEVEL SECURITY;

UPDATE catalog.applications
SET blueprint_key = CASE type_key WHEN 'restful-service' THEN 'node-service' WHEN 'web-frontend' THEN 'angular-frontend' END;

ALTER TABLE catalog.applications FORCE ROW LEVEL SECURITY;

ALTER TABLE catalog.applications ALTER COLUMN blueprint_key SET NOT NULL;

-- The view gains the blueprint, so its result changes, and it's made again.
DROP FUNCTION catalog.applications_view();

CREATE FUNCTION catalog.applications_view()
RETURNS TABLE (
  id uuid,
  name text,
  slug text,
  type_key text,
  type_name text,
  blueprint_key text,
  description text,
  status text,
  created_at timestamptz,
  created_by uuid,
  creator_name text,
  archived_at timestamptz
)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT a.id, a.name, a.slug, a.type_key, t.name, a.blueprint_key, a.description, a.status,
           a.created_at, a.created_by, u.display_name, a.archived_at
    FROM catalog.applications a
    JOIN catalog.application_types t ON t.key = a.type_key
    LEFT JOIN identity.users u ON u.id = a.created_by
    WHERE a.company_id = kernel.current_company_id();
  $$;

REVOKE ALL ON FUNCTION catalog.applications_view() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.applications_view() TO dreamdevops_app;

-- Down Migration

DROP FUNCTION catalog.applications_view();

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
GRANT EXECUTE ON FUNCTION catalog.applications_view() TO dreamdevops_app;

ALTER TABLE catalog.applications DROP COLUMN blueprint_key;
