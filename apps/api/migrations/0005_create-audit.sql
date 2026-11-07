-- Up Migration

CREATE SCHEMA audit;

-- An append-only history per company. Each entry's hash covers its content and the
-- previous entry's hash, so changing or removing any entry breaks every hash after it.
CREATE TABLE audit.entries (
  company_id uuid NOT NULL REFERENCES tenancy.companies (id),
  sequence bigint NOT NULL CHECK (sequence >= 1),
  event_id uuid NOT NULL UNIQUE,
  event_type text NOT NULL,
  event_version integer NOT NULL,
  actor_id uuid,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  previous_hash text NOT NULL,
  hash text NOT NULL,
  PRIMARY KEY (company_id, sequence)
);

CREATE INDEX entries_actor_idx ON audit.entries (actor_id, occurred_at DESC);

-- Nobody may change or delete history through normal SQL, not even the table owner.
-- The hash chain still exposes anyone who gets around this.
CREATE FUNCTION audit.refuse_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
    BEGIN
      RAISE EXCEPTION 'The audit log cannot be changed or deleted.';
    END;
  $$;

CREATE TRIGGER entries_append_only
  BEFORE UPDATE OR DELETE ON audit.entries
  FOR EACH ROW EXECUTE FUNCTION audit.refuse_change();

CREATE TRIGGER entries_no_truncate
  BEFORE TRUNCATE ON audit.entries
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();

-- RLS isn't forced, so the function below can read one person's actions across
-- companies. The application role is always limited to the current company.
ALTER TABLE audit.entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY entries_company_isolation ON audit.entries
  TO dreamdevops_app
  USING (company_id = kernel.current_company_id())
  WITH CHECK (company_id = kernel.current_company_id());

-- The current company's history, newest first, with each actor's name.
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

-- One person's own actions across companies, for platform admins.
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

REVOKE ALL ON FUNCTION audit.company_entries(bigint, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.actor_entries(uuid, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.refuse_change() FROM PUBLIC;

GRANT USAGE ON SCHEMA audit TO dreamdevops_app;
GRANT SELECT, INSERT ON audit.entries TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION audit.company_entries(bigint, integer) TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION audit.actor_entries(uuid, timestamptz, integer) TO dreamdevops_app;

-- Down Migration

DROP SCHEMA audit CASCADE;
