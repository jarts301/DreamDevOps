-- Up Migration

-- Alerts email members of the company, not addresses typed in. Each email goes to the
-- member's address as Identity knows it when it's sent, and only while they're still a
-- member, so nobody who left the company is emailed, and a changed address is followed.
-- Alerts learn who the members are through Identity's published CompanyMembers, and keep
-- only their IDs, without foreign keys, as every newer module does.
--
-- An alert may end up naming nobody, when everyone it named has left, and says so. New
-- and changed alerts must name at least one member, which the API checks.
ALTER TABLE alerts.alerts
  ADD COLUMN recipient_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(recipient_ids) <= 10);

-- Each address an alert had becomes the member with that address, in the alert's company.
-- Addresses of nobody in the company are dropped. Row-level security hides every
-- company's alerts from the tables' owner, so it's lifted for this update only, inside
-- this migration's transaction.
ALTER TABLE alerts.alerts NO FORCE ROW LEVEL SECURITY;

UPDATE alerts.alerts a
SET recipient_ids = ARRAY(
  SELECT DISTINCT m.user_id
  FROM identity.memberships m
  JOIN identity.users u ON u.id = m.user_id
  WHERE m.company_id = a.company_id AND lower(u.email) = ANY (a.recipients)
);

ALTER TABLE alerts.alerts FORCE ROW LEVEL SECURITY;

ALTER TABLE alerts.alerts ALTER COLUMN recipient_ids DROP DEFAULT, DROP COLUMN recipients;

GRANT UPDATE (recipient_ids) ON alerts.alerts TO dreamdevops_app;

-- Down Migration

ALTER TABLE alerts.alerts ADD COLUMN recipients text[] NOT NULL DEFAULT '{}';

ALTER TABLE alerts.alerts NO FORCE ROW LEVEL SECURITY;

UPDATE alerts.alerts a
SET recipients = ARRAY(
  SELECT DISTINCT lower(u.email)
  FROM identity.memberships m
  JOIN identity.users u ON u.id = m.user_id
  WHERE m.company_id = a.company_id AND m.user_id = ANY (a.recipient_ids)
);

-- Before this migration, every alert named at least one address.
DELETE FROM alerts.alerts WHERE cardinality(recipients) = 0;

ALTER TABLE alerts.alerts FORCE ROW LEVEL SECURITY;

ALTER TABLE alerts.alerts
  ALTER COLUMN recipients DROP DEFAULT,
  ADD CONSTRAINT alerts_recipients_check CHECK (cardinality(recipients) BETWEEN 1 AND 10),
  DROP COLUMN recipient_ids;

GRANT UPDATE (recipients) ON alerts.alerts TO dreamdevops_app;
