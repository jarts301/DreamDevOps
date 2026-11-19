-- Up Migration

-- One person's own actions across companies now page by time and event ID together, so
-- entries that share a time at the end of a page are neither skipped nor shown twice.
-- Company names no longer come from Tenancy's table: the API asks Tenancy's published
-- company directory, so this schema reads only its own.
CREATE FUNCTION audit.actor_entries(
  p_actor_id uuid,
  p_before_time timestamptz,
  p_before_event uuid,
  p_limit integer
)
RETURNS TABLE (
  company_id uuid,
  event_id uuid,
  event_type text,
  occurred_at timestamptz,
  payload jsonb
)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT e.company_id, e.event_id, e.event_type, e.occurred_at, e.payload
    FROM audit.entries e
    WHERE e.actor_id = p_actor_id
      AND (p_before_time IS NULL OR (e.occurred_at, e.event_id) < (p_before_time, p_before_event))
    ORDER BY e.occurred_at DESC, e.event_id DESC
    LIMIT least(p_limit, 200);
  $$;

CREATE INDEX entries_actor_event_idx ON audit.entries (actor_id, occurred_at DESC, event_id DESC);
DROP INDEX audit.entries_actor_idx;
DROP FUNCTION audit.actor_entries(uuid, timestamptz, integer);

REVOKE ALL ON FUNCTION audit.actor_entries(uuid, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.actor_entries(uuid, timestamptz, uuid, integer) TO dreamdevops_app;

-- Down Migration

CREATE FUNCTION audit.actor_entries(p_actor_id uuid, p_before timestamptz, p_limit integer)
RETURNS TABLE (
  company_id uuid,
  company_name text,
  event_type text,
  occurred_at timestamptz,
  payload jsonb
)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT e.company_id, c.name, e.event_type, e.occurred_at, e.payload
    FROM audit.entries e
    JOIN tenancy.companies c ON c.id = e.company_id
    WHERE e.actor_id = p_actor_id
      AND (p_before IS NULL OR e.occurred_at < p_before)
    ORDER BY e.occurred_at DESC, e.event_id
    LIMIT least(p_limit, 200);
  $$;
REVOKE ALL ON FUNCTION audit.actor_entries(uuid, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.actor_entries(uuid, timestamptz, integer) TO dreamdevops_app;

CREATE INDEX entries_actor_idx ON audit.entries (actor_id, occurred_at DESC);
DROP INDEX audit.entries_actor_event_idx;
DROP FUNCTION audit.actor_entries(uuid, timestamptz, uuid, integer);
