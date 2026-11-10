-- Up Migration

CREATE SCHEMA environments;

-- Where environments can run: a company's cloud accounts and self-hosted servers. The
-- provider says what kind it is, and its settings are checked against that provider.
-- Credentials are never stored here.
--
-- Like every table of a newer module, these hold other modules' IDs without foreign
-- keys to their schemas, so this module's data can later move to its own database.
CREATE TABLE environments.targets (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  -- Fixed at creation: a target is one place, so moving means choosing another target.
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{1,39}$'),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  status text NOT NULL CHECK (status IN ('active', 'archived')),
  -- Goes up with every change, so nobody overwrites a change they haven't seen.
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  -- Lets environments refer to a target of their own company only.
  UNIQUE (id, company_id)
);

CREATE UNIQUE INDEX targets_name_idx ON environments.targets (company_id, lower(name));

-- Each application's environments. Production ones are protected from mistakes: the
-- API asks for their name and a reason before changing them, and the rules below hold
-- even if a bug gets past it.
CREATE TABLE environments.environments (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  application_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 40),
  -- Fixed at creation, because it will name the environment's infrastructure.
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$'),
  production boolean NOT NULL DEFAULT false,
  target_id uuid,
  status text NOT NULL CHECK (status IN ('active', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (application_id, slug),
  FOREIGN KEY (target_id, company_id) REFERENCES environments.targets (id, company_id),
  -- Production is never archived. Its protection has to be removed first.
  CONSTRAINT production_not_archived CHECK (NOT (production AND status = 'archived'))
);

CREATE UNIQUE INDEX environments_name_idx ON environments.environments (application_id, lower(name));
CREATE INDEX environments_target_idx ON environments.environments (target_id);

ALTER TABLE environments.targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments.targets FORCE ROW LEVEL SECURITY;
ALTER TABLE environments.environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments.environments FORCE ROW LEVEL SECURITY;

CREATE POLICY targets_company_isolation ON environments.targets
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

CREATE POLICY environments_company_isolation ON environments.environments
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

-- Nothing is ever deleted, so the app has no DELETE right: targets and environments are
-- archived, and their history stays.
GRANT USAGE ON SCHEMA environments TO dreamdevops_app;
GRANT SELECT, INSERT, UPDATE (name, settings, status, version, updated_at, archived_at)
  ON environments.targets TO dreamdevops_app;
GRANT SELECT, INSERT, UPDATE (name, production, target_id, status, version, updated_at, archived_at)
  ON environments.environments TO dreamdevops_app;

-- Non-production environments are managed by those who run applications. Production is
-- managed by those who may also deploy to it.
INSERT INTO identity.role_permissions (role_key, permission) VALUES
  ('company-admin', 'environments:manage'),
  ('tech-lead', 'environments:manage'),
  ('operator', 'environments:manage'),
  ('tech-lead', 'environments-production:manage'),
  ('operator', 'environments-production:manage');

-- Down Migration

DELETE FROM identity.role_permissions WHERE permission IN ('environments:manage', 'environments-production:manage');
DROP SCHEMA environments CASCADE;
