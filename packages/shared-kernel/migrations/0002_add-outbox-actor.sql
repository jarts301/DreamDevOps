-- Up Migration

-- Who caused each event, so the audit log can show it. Null when the platform acted on its own.
ALTER TABLE kernel.outbox ADD COLUMN actor_id uuid;

-- Down Migration

ALTER TABLE kernel.outbox DROP COLUMN actor_id;
