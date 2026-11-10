-- Up Migration

-- Each environment's variables and secrets, which its containers get when they start.
-- Plain variables are kept as text. Secrets are sealed with AES-256-GCM and a key only
-- the API holds, never in the database, and their values are never shown again.
CREATE TABLE environments.variables (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$' AND upper(name) NOT LIKE 'DREAMDEVOPS\_%'),
  secret boolean NOT NULL,
  -- A plain variable's value.
  value text CHECK (octet_length(value) <= 32768),
  -- A secret's sealed value, the nonce it was sealed with, its authentication tag, and
  -- which key sealed it.
  ciphertext bytea CHECK (octet_length(ciphertext) <= 32768),
  nonce bytea CHECK (octet_length(nonce) = 12),
  tag bytea CHECK (octet_length(tag) = 16),
  key_id text CHECK (key_id ~ '^[0-9a-f]{16}$'),
  -- Goes up with every change, so nobody overwrites a change they haven't seen.
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  -- Kept as it was, so the list reads the same after someone changes their name.
  updated_by_name text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (environment_id, company_id) REFERENCES environments.environments (id, company_id),
  -- A secret is only ever stored sealed, and a plain variable never is.
  CONSTRAINT secrets_are_sealed CHECK (
    (secret AND value IS NULL AND ciphertext IS NOT NULL AND nonce IS NOT NULL AND tag IS NOT NULL AND key_id IS NOT NULL)
    OR (NOT secret AND value IS NOT NULL AND ciphertext IS NULL AND nonce IS NULL AND tag IS NULL AND key_id IS NULL)
  )
);

-- Names differing only in case would confuse people, so an environment has one of each.
CREATE UNIQUE INDEX variables_name_idx ON environments.variables (environment_id, upper(name));

-- Counts changes to an environment's variables. Each deployment records the count it
-- started with, so the dashboard can tell when what runs has older settings.
ALTER TABLE environments.environments
  ADD COLUMN settings_revision integer NOT NULL DEFAULT 0 CHECK (settings_revision >= 0);
ALTER TABLE environments.deployments ADD COLUMN settings_revision integer CHECK (settings_revision >= 0);

ALTER TABLE environments.variables ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments.variables FORCE ROW LEVEL SECURITY;

CREATE POLICY variables_company_isolation ON environments.variables
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

-- Variables are settings, not history: removing one deletes it. The audit log keeps what
-- happened, without values.
GRANT SELECT, INSERT, DELETE,
  UPDATE (value, ciphertext, nonce, tag, key_id, version, updated_by, updated_by_name, updated_at)
  ON environments.variables TO dreamdevops_app;
GRANT UPDATE (settings_revision) ON environments.environments TO dreamdevops_app;
GRANT UPDATE (settings_revision) ON environments.deployments TO dreamdevops_app;

-- Down Migration

REVOKE UPDATE (settings_revision) ON environments.deployments FROM dreamdevops_app;
REVOKE UPDATE (settings_revision) ON environments.environments FROM dreamdevops_app;
ALTER TABLE environments.deployments DROP COLUMN settings_revision;
ALTER TABLE environments.environments DROP COLUMN settings_revision;
DROP TABLE environments.variables;
