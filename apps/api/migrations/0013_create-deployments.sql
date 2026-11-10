-- Up Migration

-- Every company gets one target for the machine that runs DreamDevOps, and no more:
-- there's only one such machine.
CREATE UNIQUE INDEX targets_one_local_idx ON environments.targets (company_id) WHERE provider = 'local';

-- Lets deployments refer to an environment of their own company only.
ALTER TABLE environments.environments ADD CONSTRAINT environments_id_company_key UNIQUE (id, company_id);

-- Each time a version is deployed to an environment, moved to another target with it, or
-- stopped, with the progress of each step. Deployments are never deleted, so each
-- environment's history stays readable.
CREATE TABLE environments.deployments (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  application_id uuid NOT NULL,
  -- Counts each environment's deployments, for people: #1, #2, ...
  number integer NOT NULL CHECK (number >= 1),
  kind text NOT NULL CHECK (kind IN ('deploy', 'move', 'stop')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  -- The image, from Builds. A stop names the version it stops, if any ran.
  build_id uuid,
  version text CHECK (length(version) <= 128),
  image_kind text CHECK (image_kind IN ('development', 'release-candidate', 'hotfix-candidate', 'release')),
  productive boolean NOT NULL DEFAULT false,
  repository text CHECK (length(repository) <= 255),
  -- Images run by digest, never by tag, so what runs is exactly what was signed.
  digest text CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  -- Whether the environment was production when this was asked for.
  production boolean NOT NULL,
  target_id uuid NOT NULL,
  -- For a move, where it ran before.
  previous_target_id uuid,
  host_port integer CHECK (host_port BETWEEN 1 AND 65535),
  address text CHECK (length(address) <= 300),
  steps jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  requested_by uuid,
  -- Kept as it was, so the history reads the same after someone changes their name.
  requested_by_name text,
  reason text CHECK (length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment_id, number),
  FOREIGN KEY (environment_id, company_id) REFERENCES environments.environments (id, company_id),
  FOREIGN KEY (target_id, company_id) REFERENCES environments.targets (id, company_id),
  FOREIGN KEY (previous_target_id, company_id) REFERENCES environments.targets (id, company_id),
  CONSTRAINT deploys_name_an_image CHECK (
    kind = 'stop' OR (build_id IS NOT NULL AND version IS NOT NULL AND repository IS NOT NULL AND digest IS NOT NULL)
  ),
  CONSTRAINT moves_name_where_from CHECK ((kind = 'move') = (previous_target_id IS NOT NULL)),
  -- Production runs only releases, even if a bug gets past the API.
  CONSTRAINT production_runs_releases CHECK (NOT production OR kind = 'stop' OR productive)
);

-- One deployment per environment at a time.
CREATE UNIQUE INDEX deployments_one_active_idx ON environments.deployments (environment_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX deployments_target_idx ON environments.deployments (target_id);

-- What runs in each environment now: its latest deployment that succeeded, unless it was
-- stopped, or a failure left nothing running.
ALTER TABLE environments.environments
  ADD COLUMN live_deployment_id uuid REFERENCES environments.deployments (id);

-- A production environment never runs an image production mustn't: neither by deploying
-- one, nor by marking an environment that runs one as production.
CREATE FUNCTION environments.production_runs_releases()
RETURNS trigger
  LANGUAGE plpgsql SET search_path = ''
  AS $$
    BEGIN
      IF NEW.production AND NEW.live_deployment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM environments.deployments d
        WHERE d.id = NEW.live_deployment_id AND d.environment_id = NEW.id AND d.kind <> 'stop' AND d.productive
      ) THEN
        RAISE EXCEPTION 'Production environments run only releases.' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
  $$;

CREATE TRIGGER production_runs_releases
  BEFORE INSERT OR UPDATE OF production, live_deployment_id ON environments.environments
  FOR EACH ROW EXECUTE FUNCTION environments.production_runs_releases();

ALTER TABLE environments.deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments.deployments FORCE ROW LEVEL SECURITY;

CREATE POLICY deployments_company_isolation ON environments.deployments
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

GRANT SELECT, INSERT,
  UPDATE (status, steps, host_port, address, attempts, last_error, started_at, finished_at, updated_at)
  ON environments.deployments TO dreamdevops_app;
GRANT UPDATE (live_deployment_id) ON environments.environments TO dreamdevops_app;

-- Down Migration

REVOKE UPDATE (live_deployment_id) ON environments.environments FROM dreamdevops_app;
DROP TRIGGER production_runs_releases ON environments.environments;
DROP FUNCTION environments.production_runs_releases();
ALTER TABLE environments.environments DROP COLUMN live_deployment_id;
DROP TABLE environments.deployments;
ALTER TABLE environments.environments DROP CONSTRAINT environments_id_company_key;
DROP INDEX environments.targets_one_local_idx;
