-- Up Migration

-- The companies with at least one alert that's on, for the check that runs every minute.
-- One query for every company, rather than one transaction for each, every minute. Like
-- the other sweeps' functions, it runs as the owner, and returns only companies' IDs.
CREATE POLICY alerts_owner_lookup ON alerts.alerts FOR SELECT TO dreamdevops_owner USING (true);

CREATE FUNCTION alerts.companies_with_enabled_alerts()
RETURNS TABLE (company_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT DISTINCT company_id FROM alerts.alerts WHERE enabled;
  $$;

CREATE INDEX alerts_enabled_company_idx ON alerts.alerts (company_id) WHERE enabled;

REVOKE ALL ON FUNCTION alerts.companies_with_enabled_alerts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alerts.companies_with_enabled_alerts() TO dreamdevops_app;

-- Down Migration

DROP INDEX alerts.alerts_enabled_company_idx;
DROP FUNCTION alerts.companies_with_enabled_alerts();
DROP POLICY alerts_owner_lookup ON alerts.alerts;
