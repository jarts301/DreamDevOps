-- Up Migration

CREATE SCHEMA notification;

-- Rules that post chosen events to a chat tool. The address often contains a secret,
-- so the API never shows it in full after it's saved.
CREATE TABLE notification.rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  kind text NOT NULL CHECK (kind IN ('slack', 'generic')),
  url text NOT NULL,
  event_types text[] NOT NULL CHECK (cardinality(event_types) > 0),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES identity.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_delivery_at timestamptz,
  last_error text
);

CREATE INDEX rules_company_idx ON notification.rules (company_id);

ALTER TABLE notification.rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification.rules FORCE ROW LEVEL SECURITY;

CREATE POLICY rules_company_isolation ON notification.rules
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

GRANT USAGE ON SCHEMA notification TO dreamdevops_app;
GRANT SELECT, INSERT, DELETE,
  UPDATE (name, event_types, enabled, updated_at, last_delivery_at, last_error)
  ON notification.rules TO dreamdevops_app;

INSERT INTO identity.role_permissions (role_key, permission) VALUES ('company-admin', 'notifications:manage');

-- Down Migration

DELETE FROM identity.role_permissions WHERE permission = 'notifications:manage';
DROP SCHEMA notification CASCADE;
