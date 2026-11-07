-- Up Migration

CREATE SCHEMA editions;

-- Each company's edition. A company without a row is on the Community Edition.
-- Like the company register, this is platform data: it says what a company may use,
-- not anything the company stores, so it isn't limited by row-level security.
CREATE TABLE editions.company_editions (
  company_id uuid PRIMARY KEY REFERENCES tenancy.companies (id),
  edition text NOT NULL CHECK (edition IN ('community', 'commercial')),
  changed_by uuid REFERENCES identity.users (id),
  changed_at timestamptz NOT NULL DEFAULT now()
);

GRANT USAGE ON SCHEMA editions TO dreamdevops_app;
GRANT SELECT, INSERT, UPDATE (edition, changed_by, changed_at) ON editions.company_editions TO dreamdevops_app;

INSERT INTO identity.role_permissions (role_key, permission) VALUES ('platform-admin', 'editions:manage');

-- Down Migration

DELETE FROM identity.role_permissions WHERE permission = 'editions:manage';
DROP SCHEMA editions CASCADE;
