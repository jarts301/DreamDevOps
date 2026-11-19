-- Up Migration

CREATE SCHEMA alerts;

-- Each alert watches one metric of one application in one environment, its place, such
-- as the CPU of Billing API in production. It emails the company members it names when the
-- metric crosses its threshold for long enough, and again when it's back. Members are kept
-- by their user IDs, and emails go to their address as Identity knows it when each is sent,
-- only while they're still members.
--
-- Like every table of a newer module, these hold other modules' IDs without foreign keys
-- to their schemas, so this module's data can later move to its own database.
CREATE TABLE alerts.alerts (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  -- Made from the environment and application, as their telemetry is labelled.
  place_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  application_id uuid NOT NULL,
  metric text NOT NULL CHECK (metric IN ('cpu', 'memory', 'requests', 'responseTime', 'errors')),
  comparator text NOT NULL CHECK (comparator IN ('above', 'below')),
  -- In the metric's own unit: percent, bytes, requests each second, or seconds.
  threshold double precision NOT NULL CHECK (threshold >= 0 AND threshold < 'Infinity'),
  -- How long the metric must stay past the threshold before the alert fires.
  for_minutes integer NOT NULL CHECK (for_minutes BETWEEN 0 AND 60),
  -- New and changed alerts name at least one, which the API checks. One may end up naming
  -- nobody, when everyone it named has left the company.
  recipient_ids uuid[] NOT NULL CHECK (cardinality(recipient_ids) <= 10),
  enabled boolean NOT NULL DEFAULT true,
  -- What the last check found: ok, past the threshold but not yet for long enough
  -- (pending), or firing.
  state text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'pending', 'firing')),
  pending_since timestamptz,
  last_value double precision,
  last_checked_at timestamptz,
  -- Why the last check couldn't read the metric, such as the metrics store being down.
  check_problem text,
  last_notified_at timestamptz,
  last_notification_error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pending_has_start CHECK ((state = 'pending') = (pending_since IS NOT NULL)),
  -- Lets incidents refer to an alert of their own company only.
  UNIQUE (id, company_id)
);

CREATE UNIQUE INDEX alerts_name_idx ON alerts.alerts (company_id, lower(name));
CREATE INDEX alerts_place_idx ON alerts.alerts (company_id, place_id);

-- Each time an alert fired, until it was resolved. An alert has at most one open incident.
CREATE TABLE alerts.incidents (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  alert_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  start_value double precision,
  resolved_at timestamptz,
  end_value double precision,
  -- How it ended: the metric came back, or someone turned the alert off.
  ended_by text CHECK (ended_by IN ('recovered', 'turned-off')),
  CONSTRAINT resolved_has_reason CHECK ((resolved_at IS NULL) = (ended_by IS NULL)),
  FOREIGN KEY (alert_id, company_id) REFERENCES alerts.alerts (id, company_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX incidents_one_open_idx ON alerts.incidents (alert_id) WHERE resolved_at IS NULL;
CREATE INDEX incidents_company_started_idx ON alerts.incidents (company_id, started_at DESC);

ALTER TABLE alerts.alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts.alerts FORCE ROW LEVEL SECURITY;
ALTER TABLE alerts.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts.incidents FORCE ROW LEVEL SECURITY;

CREATE POLICY alerts_company_isolation ON alerts.alerts
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

CREATE POLICY incidents_company_isolation ON alerts.incidents
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

-- What an alert watches is fixed at creation, so its emails always describe it truly.
-- Watching something else is a new alert.
GRANT USAGE ON SCHEMA alerts TO dreamdevops_app;
GRANT SELECT, INSERT, DELETE,
  UPDATE (name, threshold, for_minutes, recipient_ids, enabled, state, pending_since, last_value, last_checked_at,
          check_problem, last_notified_at, last_notification_error, updated_at)
  ON alerts.alerts TO dreamdevops_app;
GRANT SELECT, INSERT, UPDATE (resolved_at, end_value, ended_by) ON alerts.incidents TO dreamdevops_app;

-- Alerts are managed by those who run applications. Every member who views dashboards sees them.
INSERT INTO identity.role_permissions (role_key, permission) VALUES
  ('company-admin', 'alerts:manage'),
  ('tech-lead', 'alerts:manage'),
  ('operator', 'alerts:manage');

-- Down Migration

DELETE FROM identity.role_permissions WHERE permission = 'alerts:manage';
DROP SCHEMA alerts CASCADE;
