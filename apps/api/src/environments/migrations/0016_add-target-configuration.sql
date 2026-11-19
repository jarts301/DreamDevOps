-- Up Migration

-- Each environment's manifests live in its own Git repository, which only its target
-- reads. Production environments can require a second person to approve deployments.
ALTER TABLE environments.environments
  ADD COLUMN repository text CHECK (repository ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  ADD COLUMN requires_approval boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT environments_approval_check CHECK (kind = 'production' OR NOT requires_approval);

-- The read-only SSH key Flux in the target uses for its environment repository. The
-- agent makes it in the cluster; only the public key is sent.
ALTER TABLE environments.targets
  ADD COLUMN deploy_key text CHECK (deploy_key ~ '^ssh-ed25519 [A-Za-z0-9+/=]{60,100}$');

-- Each company's read-only account for pulling its images. The token is encrypted with
-- a key the database never sees.
CREATE TABLE environments.pull_accounts (
  company_id uuid PRIMARY KEY REFERENCES tenancy.companies (id),
  username text NOT NULL,
  token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE environments.pull_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments.pull_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY pull_accounts_company_isolation ON environments.pull_accounts TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

GRANT UPDATE (repository, requires_approval) ON environments.environments TO dreamdevops_app;
GRANT SELECT, INSERT, UPDATE ON environments.pull_accounts TO dreamdevops_app;

-- Down Migration

DROP TABLE environments.pull_accounts;
ALTER TABLE environments.targets DROP COLUMN deploy_key;
ALTER TABLE environments.environments
  DROP CONSTRAINT environments_approval_check,
  DROP COLUMN requires_approval,
  DROP COLUMN repository;
