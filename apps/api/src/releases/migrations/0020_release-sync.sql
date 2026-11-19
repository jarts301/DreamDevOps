-- Up Migration

-- Companies with releases still open, so the platform can catch up, in every company, on
-- merges and pushes the Git tool told it about while it wasn't listening. It returns
-- only company IDs, and each company's releases are then read in that company.
-- The function runs as the owner, and only reads.
CREATE POLICY releases_owner_lookup ON releases.releases FOR SELECT TO dreamdevops_owner USING (true);

CREATE FUNCTION releases.companies_with_open_releases()
RETURNS TABLE (company_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT DISTINCT company_id FROM releases.releases WHERE status = 'open';
  $$;

REVOKE ALL ON FUNCTION releases.companies_with_open_releases() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION releases.companies_with_open_releases() TO dreamdevops_app;

-- Down Migration

DROP FUNCTION releases.companies_with_open_releases();
DROP POLICY releases_owner_lookup ON releases.releases;
