-- Up Migration

-- Each company's name, as Notifications heard it from Tenancy's CompanyCreated and
-- CompanyRenamed events, so chat messages name the company without asking Tenancy.
-- named_at is when the name was given, so an event that arrives late, or again, never
-- puts back an older name. There's no foreign key to tenancy.companies: the name comes
-- from events, and Notifications keeps to its own schema.
CREATE TABLE notification.companies (
  company_id uuid PRIMARY KEY,
  name text NOT NULL,
  named_at timestamptz NOT NULL
);

ALTER TABLE notification.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification.companies FORCE ROW LEVEL SECURITY;

CREATE POLICY companies_company_isolation ON notification.companies
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

GRANT SELECT, INSERT, UPDATE (name, named_at) ON notification.companies TO dreamdevops_app;

-- Down Migration

DROP TABLE notification.companies;
