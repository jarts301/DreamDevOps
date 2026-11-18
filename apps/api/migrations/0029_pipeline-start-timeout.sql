-- Up Migration

-- When each build's pipeline was started. A pipeline whose jobs never report, such as when
-- no runner is free or its jobs can't reach the API, is failed after a short while, rather
-- than once the whole build times out.
ALTER TABLE builds.builds ADD COLUMN pipeline_started_at timestamptz;
GRANT UPDATE (pipeline_started_at) ON builds.builds TO dreamdevops_app;

-- Running builds, in every company, whose pipeline started before the given time and none
-- of whose jobs has said anything yet: no job started, reported or failed. For the sweep.
CREATE FUNCTION builds.unstarted_builds(p_started_before timestamptz)
RETURNS TABLE (build_id uuid, company_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT id, company_id FROM builds.builds
    WHERE status = 'running'
      AND pipeline_started_at < p_started_before
      AND NOT (reports ?| ARRAY['started', 'secrets', 'tests', 'failedJobs'])
    LIMIT 100;
  $$;

REVOKE ALL ON FUNCTION builds.unstarted_builds(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION builds.unstarted_builds(timestamptz) TO dreamdevops_app;

-- Down Migration

DROP FUNCTION builds.unstarted_builds(timestamptz);
REVOKE UPDATE (pipeline_started_at) ON builds.builds FROM dreamdevops_app;
ALTER TABLE builds.builds DROP COLUMN pipeline_started_at;
