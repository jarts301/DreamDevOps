-- Up Migration

-- Reads the company set for the current transaction. It returns NULL when none is
-- set, and NULL never matches a company, so queries without a tenant see no rows.
CREATE FUNCTION kernel.current_company_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.current_company_id', true), '')::uuid $$;

CREATE TABLE kernel.outbox (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  event_type text NOT NULL,
  event_version integer NOT NULL CHECK (event_version >= 1),
  company_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX outbox_unpublished_idx ON kernel.outbox (sequence) WHERE published_at IS NULL;

ALTER TABLE kernel.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE kernel.outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY outbox_company_isolation ON kernel.outbox
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

-- The relay delivers events for every company, but can change only published_at.
CREATE POLICY outbox_relay_access ON kernel.outbox
  TO dreamdevops_relay
  USING (true);

GRANT USAGE ON SCHEMA kernel TO dreamdevops_app, dreamdevops_relay;
GRANT EXECUTE ON FUNCTION kernel.current_company_id() TO dreamdevops_app;
GRANT SELECT, INSERT ON kernel.outbox TO dreamdevops_app;
GRANT SELECT, UPDATE (published_at) ON kernel.outbox TO dreamdevops_relay;

-- Down Migration

DROP TABLE kernel.outbox;
DROP FUNCTION kernel.current_company_id();
