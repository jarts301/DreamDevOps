-- Up Migration

-- Records which version of the repository rules each repository has, so newer rules,
-- such as webhooks and required checks, reach repositories made before them.
ALTER TABLE source.repositories ADD COLUMN policy_version integer NOT NULL DEFAULT 1;
GRANT UPDATE (policy_version) ON source.repositories TO dreamdevops_app;

CREATE SCHEMA webhooks;

-- Every delivery accepted, so a delivery sent twice, or replayed, is handled once.
CREATE TABLE webhooks.deliveries (
  delivery_id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  application_id uuid NOT NULL REFERENCES catalog.applications (id),
  event text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE webhooks.deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks.deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY deliveries_company_isolation ON webhooks.deliveries
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

-- The function below runs as the owner. It reads one repository by its exact name.
CREATE POLICY repositories_owner_lookup ON source.repositories
  FOR SELECT
  TO dreamdevops_owner
  USING (true);

-- Finds which application and company a repository belongs to. A webhook arrives with
-- no company context, and this tells the gateway which company's secret to check.
CREATE FUNCTION webhooks.repository_owner(p_organization text, p_name text)
RETURNS TABLE (application_id uuid, company_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT r.application_id, r.company_id
    FROM source.repositories r
    WHERE r.organization = p_organization AND r.name = p_name AND r.status = 'ready';
  $$;

REVOKE ALL ON FUNCTION webhooks.repository_owner(text, text) FROM PUBLIC;

GRANT USAGE ON SCHEMA webhooks TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION webhooks.repository_owner(text, text) TO dreamdevops_app;
GRANT SELECT, INSERT ON webhooks.deliveries TO dreamdevops_app;

-- Down Migration

DROP SCHEMA webhooks CASCADE;
DROP POLICY repositories_owner_lookup ON source.repositories;
ALTER TABLE source.repositories DROP COLUMN policy_version;
