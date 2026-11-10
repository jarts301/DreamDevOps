-- Up Migration

CREATE SCHEMA builds;

-- Every image the platform builds for an application, with the version it carries and
-- the progress of each step. Builds are never deleted, so a version always names one
-- image, and the history of each release stays readable.
CREATE TABLE builds.builds (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  application_id uuid NOT NULL REFERENCES catalog.applications (id),
  -- Counts each application's builds, for people: #1, #2, ...
  number integer NOT NULL CHECK (number >= 1),
  kind text NOT NULL CHECK (kind IN ('development', 'release-candidate', 'hotfix-candidate', 'release')),
  -- A semantic version that's also a valid image tag, so it has no build metadata.
  version text NOT NULL CHECK (
    length(version) <= 128
    AND version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
  ),
  branch text NOT NULL CHECK (length(branch) BETWEEN 1 AND 255),
  pull_request integer CHECK (pull_request >= 1),
  -- Fixed when the build is requested, so every step and every retry builds the same code.
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  -- What started the build. It's unique, so a webhook delivered twice, or a webhook and
  -- the platform noticing the same change, start only one build.
  trigger text NOT NULL CHECK (length(trigger) BETWEEN 1 AND 300),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  -- Each step's progress, checks and results, in the order they run.
  steps jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
  image text,
  digest text CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  requested_by uuid REFERENCES identity.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, number),
  UNIQUE (application_id, version),
  UNIQUE (application_id, trigger)
);

CREATE INDEX builds_company_idx ON builds.builds (company_id);

ALTER TABLE builds.builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE builds.builds FORCE ROW LEVEL SECURITY;

CREATE POLICY builds_company_isolation ON builds.builds
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

-- The function below runs as the owner, which row-level security also limits. It may
-- only read, and only the current company.
CREATE POLICY builds_owner_read ON builds.builds
  FOR SELECT
  TO dreamdevops_owner
  USING (company_id = kernel.current_company_id());

-- The current company's builds, with the name of whoever asked for each one. The app
-- role can't read the user table, so this function reads only those names.
CREATE FUNCTION builds.builds_view()
RETURNS TABLE (
  id uuid,
  application_id uuid,
  number integer,
  kind text,
  version text,
  branch text,
  pull_request integer,
  commit_sha text,
  trigger text,
  status text,
  steps jsonb,
  image text,
  digest text,
  attempts integer,
  last_error text,
  requested_by uuid,
  requester_name text,
  created_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz
)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT b.id, b.application_id, b.number, b.kind, b.version, b.branch, b.pull_request, b.commit_sha,
           b.trigger, b.status, b.steps, b.image, b.digest, b.attempts, b.last_error, b.requested_by,
           u.display_name, b.created_at, b.started_at, b.finished_at
    FROM builds.builds b
    LEFT JOIN identity.users u ON u.id = b.requested_by
    WHERE b.company_id = kernel.current_company_id();
  $$;

REVOKE ALL ON FUNCTION builds.builds_view() FROM PUBLIC;

GRANT USAGE ON SCHEMA builds TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION builds.builds_view() TO dreamdevops_app;
GRANT SELECT, INSERT,
  UPDATE (status, steps, image, digest, attempts, last_error, started_at, finished_at, updated_at)
  ON builds.builds TO dreamdevops_app;

-- Down Migration

DROP SCHEMA builds CASCADE;
