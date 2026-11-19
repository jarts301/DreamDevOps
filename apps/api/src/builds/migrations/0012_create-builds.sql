-- Up Migration

CREATE SCHEMA builds;

-- Every image build: feature images on request, RC images for each release commit, and
-- final images after a release merges. A finished build that succeeded is a version.
CREATE TABLE builds.builds (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  application_id uuid NOT NULL REFERENCES catalog.applications (id),
  kind text NOT NULL CHECK (kind IN ('feature', 'rc', 'final')),
  branch text,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40,64}$'),
  image_tag text NOT NULL CHECK (image_tag ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'),
  version text,
  release_id uuid,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'deleted')),
  failure_reason text,
  -- What each pipeline job reported: secrets found, test results, the scan and the SBOM size.
  reports jsonb NOT NULL DEFAULT '{}',
  image_ref text,
  digest text CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  signing_key text CHECK (signing_key IN ('test', 'release')),
  signed_at timestamptz,
  -- Only a hash of the one-time token the pipeline uses is kept.
  token_hash text,
  token_expires_at timestamptz,
  requested_by uuid REFERENCES identity.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX builds_application_idx ON builds.builds (company_id, application_id, created_at DESC);

-- The software bill of materials of each image, as CycloneDX JSON.
CREATE TABLE builds.sboms (
  build_id uuid PRIMARY KEY REFERENCES builds.builds (id),
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  document jsonb NOT NULL
);

-- Each company's two signing keys: a test key for feature and RC images, which
-- production doesn't trust, and a release key for final images. Private keys are
-- encrypted with a key the database never sees.
CREATE TABLE builds.signing_keys (
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  purpose text NOT NULL CHECK (purpose IN ('test', 'release')),
  public_key text NOT NULL,
  private_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, purpose)
);

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['builds', 'sboms', 'signing_keys'] LOOP
    EXECUTE format('ALTER TABLE builds.%I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE builds.%I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format(
      'CREATE POLICY %I ON builds.%I TO dreamdevops_app
         USING (company_id = kernel.current_company_id())
         WITH CHECK (company_id = kernel.current_company_id())',
      name || '_company_isolation', name);
  END LOOP;
END $$;

-- The functions below run as the owner, and only read.
CREATE POLICY builds_owner_lookup ON builds.builds FOR SELECT TO dreamdevops_owner USING (true);

-- Finds a build's company. A pipeline job calls with no company context; its one-time
-- token is then checked within that company.
CREATE FUNCTION builds.build_company(p_build_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT company_id FROM builds.builds WHERE id = p_build_id;
  $$;

-- Builds that should have finished by now, in every company, for the timeout sweep.
CREATE FUNCTION builds.stale_builds(p_started_before timestamptz)
RETURNS TABLE (build_id uuid, company_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT id, company_id FROM builds.builds
    WHERE status IN ('queued', 'running') AND created_at < p_started_before
    LIMIT 100;
  $$;

-- Companies with repositories made under older rules, for the upgrade at startup.
CREATE FUNCTION source.companies_with_outdated_repositories(p_version integer)
RETURNS TABLE (company_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT DISTINCT company_id FROM source.repositories
    WHERE status = 'ready' AND policy_version < p_version;
  $$;

REVOKE ALL ON FUNCTION builds.build_company(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION builds.stale_builds(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION source.companies_with_outdated_repositories(integer) FROM PUBLIC;

GRANT USAGE ON SCHEMA builds TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION builds.build_company(uuid) TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION builds.stale_builds(timestamptz) TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION source.companies_with_outdated_repositories(integer) TO dreamdevops_app;
GRANT SELECT, INSERT,
  UPDATE (status, failure_reason, reports, image_ref, digest, signing_key, signed_at, token_hash,
          token_expires_at, updated_at, finished_at)
  ON builds.builds TO dreamdevops_app;
GRANT SELECT, INSERT ON builds.sboms TO dreamdevops_app;
GRANT SELECT, INSERT ON builds.signing_keys TO dreamdevops_app;

-- Down Migration

DROP FUNCTION source.companies_with_outdated_repositories(integer);
DROP SCHEMA builds CASCADE;
