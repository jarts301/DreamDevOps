-- Up Migration

-- Entries are numbered as they're recorded, and background delivery doesn't keep events
-- in order. The list is therefore sorted by when each change happened, and pages by that
-- time and number together. The numbers still define the hash chain.
DROP FUNCTION audit.company_entries(bigint, integer);

CREATE FUNCTION audit.company_entries(p_before_time timestamptz, p_before_sequence bigint, p_limit integer)
RETURNS TABLE (
  sequence bigint,
  event_type text,
  actor_id uuid,
  actor_name text,
  occurred_at timestamptz,
  payload jsonb
)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT e.sequence, e.event_type, e.actor_id, u.display_name, e.occurred_at, e.payload
    FROM audit.entries e
    LEFT JOIN identity.users u ON u.id = e.actor_id
    WHERE e.company_id = kernel.current_company_id()
      AND (p_before_time IS NULL OR (e.occurred_at, e.sequence) < (p_before_time, p_before_sequence))
    ORDER BY e.occurred_at DESC, e.sequence DESC
    LIMIT least(p_limit, 200);
  $$;

CREATE INDEX entries_company_time_idx ON audit.entries (company_id, occurred_at DESC, sequence DESC);

REVOKE ALL ON FUNCTION audit.company_entries(timestamptz, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.company_entries(timestamptz, bigint, integer) TO dreamdevops_app;

-- Down Migration

DROP INDEX audit.entries_company_time_idx;
DROP FUNCTION audit.company_entries(timestamptz, bigint, integer);

CREATE FUNCTION audit.company_entries(p_before bigint, p_limit integer)
RETURNS TABLE (
  sequence bigint,
  event_type text,
  actor_id uuid,
  actor_name text,
  occurred_at timestamptz,
  payload jsonb
)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT e.sequence, e.event_type, e.actor_id, u.display_name, e.occurred_at, e.payload
    FROM audit.entries e
    LEFT JOIN identity.users u ON u.id = e.actor_id
    WHERE e.company_id = kernel.current_company_id()
      AND (p_before IS NULL OR e.sequence < p_before)
    ORDER BY e.sequence DESC
    LIMIT least(p_limit, 200);
  $$;

REVOKE ALL ON FUNCTION audit.company_entries(bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.company_entries(bigint, integer) TO dreamdevops_app;
