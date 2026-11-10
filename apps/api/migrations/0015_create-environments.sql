-- Up Migration

CREATE SCHEMA environments;

-- Each company's environments. Test environments accept feature, RC and final images,
-- and may refuse feature images; production accepts final images only. The kind is fixed
-- at creation, because it decides which signing key the target trusts.
CREATE TABLE environments.environments (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 40),
  -- Fixed at creation, because it will name the environment's folder and namespaces.
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$'),
  kind text NOT NULL CHECK (kind IN ('test', 'production')),
  accepts_feature_images boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'archived')),
  created_by uuid REFERENCES identity.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (company_id, slug),
  CHECK (kind = 'test' OR NOT accepts_feature_images)
);

CREATE UNIQUE INDEX environments_name_idx ON environments.environments (company_id, lower(name));

-- The cluster that runs an environment. Connecting starts as "pending" with a one-time
-- registration token. The agent then registers its own public key, and proves itself
-- with that key from then on. Disconnected targets are kept for the history.
CREATE TABLE environments.targets (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  environment_id uuid NOT NULL REFERENCES environments.environments (id),
  status text NOT NULL CHECK (status IN ('pending', 'connected', 'lost', 'revoked')),
  -- Only hashes of tokens are kept.
  registration_token_hash text,
  registration_expires_at timestamptz,
  -- The agent's Ed25519 public key, as the base64url "x" value of its JWK.
  public_key text CHECK (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  access_token_hash text,
  access_token_expires_at timestamptz,
  agent_version text CHECK (length(agent_version) <= 40),
  kubernetes_version text CHECK (length(kubernetes_version) <= 40),
  registered_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES identity.users (id),
  created_by uuid REFERENCES identity.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'pending' OR registration_token_hash IS NULL),
  CHECK (status IN ('pending', 'revoked') OR public_key IS NOT NULL)
);

-- One environment, one target: at most one that isn't disconnected.
CREATE UNIQUE INDEX targets_one_per_environment_idx ON environments.targets (environment_id)
  WHERE status <> 'revoked';
CREATE INDEX targets_environment_idx ON environments.targets (company_id, environment_id, created_at DESC);

-- The signed assertions agents have used, so none can be replayed while still valid.
CREATE TABLE environments.used_assertions (
  target_id uuid NOT NULL REFERENCES environments.targets (id),
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  assertion_id text NOT NULL CHECK (length(assertion_id) BETWEEN 16 AND 64),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (target_id, assertion_id)
);

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['environments', 'targets', 'used_assertions'] LOOP
    EXECUTE format('ALTER TABLE environments.%I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE environments.%I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format(
      'CREATE POLICY %I ON environments.%I TO dreamdevops_app
         USING (company_id = kernel.current_company_id())
         WITH CHECK (company_id = kernel.current_company_id())',
      name || '_company_isolation', name);
  END LOOP;
END $$;

-- The functions below run as the owner, and only read.
CREATE POLICY targets_owner_lookup ON environments.targets FOR SELECT TO dreamdevops_owner USING (true);

-- Finds a target's company. An agent calls with no company context; its token or signed
-- assertion is then checked within that company.
CREATE FUNCTION environments.target_company(p_target_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT company_id FROM environments.targets WHERE id = p_target_id;
  $$;

-- Connected targets that haven't been heard from since a time, in every company, for the
-- health sweep.
CREATE FUNCTION environments.silent_targets(p_seen_before timestamptz)
RETURNS TABLE (target_id uuid, company_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT id, company_id FROM environments.targets
    WHERE status = 'connected' AND last_seen_at < p_seen_before
    LIMIT 100;
  $$;

REVOKE ALL ON FUNCTION environments.target_company(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION environments.silent_targets(timestamptz) FROM PUBLIC;

GRANT USAGE ON SCHEMA environments TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION environments.target_company(uuid) TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION environments.silent_targets(timestamptz) TO dreamdevops_app;
GRANT SELECT, INSERT, UPDATE (name, accepts_feature_images, status, updated_at, archived_at)
  ON environments.environments TO dreamdevops_app;
GRANT SELECT, INSERT, UPDATE ON environments.targets TO dreamdevops_app;
GRANT SELECT, INSERT, DELETE ON environments.used_assertions TO dreamdevops_app;

-- Down Migration

DROP SCHEMA environments CASCADE;
