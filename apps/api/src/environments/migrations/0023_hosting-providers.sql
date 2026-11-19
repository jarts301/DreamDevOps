-- Up Migration

-- What runs an environment: a Kubernetes cluster with the platform's agent, as before, or
-- "This machine", the Docker of the machine that runs DreamDevOps, for trying things out.
ALTER TABLE environments.targets
  ADD COLUMN provider text NOT NULL DEFAULT 'kubernetes' CHECK (provider IN ('kubernetes', 'local')),
  -- The provider's settings, such as the host name people reach This machine by. Never credentials.
  ADD COLUMN settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object');

-- Only a cluster's agent has a key. This machine is connected as soon as it's chosen.
DO $$
DECLARE
  found text;
BEGIN
  SELECT conname INTO found FROM pg_constraint
  WHERE conrelid = 'environments.targets'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%public_key IS NOT NULL%';
  EXECUTE format('ALTER TABLE environments.targets DROP CONSTRAINT %I', found);
END $$;
ALTER TABLE environments.targets ADD CONSTRAINT targets_agent_key_check
  CHECK (provider <> 'kubernetes' OR status IN ('pending', 'revoked') OR public_key IS NOT NULL);
ALTER TABLE environments.targets ADD CONSTRAINT targets_local_check
  CHECK (provider <> 'local' OR (status IN ('connected', 'revoked') AND public_key IS NULL));

-- Down Migration

DELETE FROM environments.targets WHERE provider = 'local';
ALTER TABLE environments.targets DROP CONSTRAINT targets_local_check;
ALTER TABLE environments.targets DROP CONSTRAINT targets_agent_key_check;
ALTER TABLE environments.targets ADD CONSTRAINT targets_check1
  CHECK (status IN ('pending', 'revoked') OR public_key IS NOT NULL);
ALTER TABLE environments.targets DROP COLUMN settings, DROP COLUMN provider;
