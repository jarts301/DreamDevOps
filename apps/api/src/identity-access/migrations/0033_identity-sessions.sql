-- Up Migration

-- Login sessions are Identity and access's, so they move into its schema, from the platform's
-- api schema. They're found before a company is known, so row-level security can't protect
-- them. Instead, Identity's role gets no access to the table, and can only call these
-- functions, which need the session's secret hash to find a row. Sessions in the api schema
-- aren't carried over: they end, and people sign in once more.
CREATE TABLE identity.sessions (
  id_hash text PRIMARY KEY,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL
);

CREATE INDEX sessions_expires_at_idx ON identity.sessions (expires_at);

CREATE FUNCTION identity.session_create(p_id_hash text, p_data jsonb, p_absolute_ms bigint, p_idle_ms bigint) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = ''
  AS $$
    DELETE FROM identity.sessions WHERE expires_at <= now() OR idle_expires_at <= now();
    INSERT INTO identity.sessions (id_hash, data, expires_at, idle_expires_at)
    VALUES (
      p_id_hash,
      p_data,
      now() + p_absolute_ms * interval '1 millisecond',
      now() + p_idle_ms * interval '1 millisecond'
    );
  $$;

CREATE FUNCTION identity.session_touch(p_id_hash text, p_idle_ms bigint) RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = ''
  AS $$
    UPDATE identity.sessions
    SET idle_expires_at = LEAST(expires_at, now() + p_idle_ms * interval '1 millisecond')
    WHERE id_hash = p_id_hash AND expires_at > now() AND idle_expires_at > now()
    RETURNING data;
  $$;

CREATE FUNCTION identity.session_update(p_id_hash text, p_data jsonb) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = ''
  AS $$
    UPDATE identity.sessions SET data = p_data WHERE id_hash = p_id_hash;
  $$;

CREATE FUNCTION identity.session_delete(p_id_hash text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = ''
  AS $$
    DELETE FROM identity.sessions WHERE id_hash = p_id_hash;
  $$;

REVOKE ALL ON FUNCTION identity.session_create(text, jsonb, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.session_touch(text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.session_update(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.session_delete(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.session_create(text, jsonb, bigint, bigint) TO dreamdevops_identity;
GRANT EXECUTE ON FUNCTION identity.session_touch(text, bigint) TO dreamdevops_identity;
GRANT EXECUTE ON FUNCTION identity.session_update(text, jsonb) TO dreamdevops_identity;
GRANT EXECUTE ON FUNCTION identity.session_delete(text) TO dreamdevops_identity;

-- Down Migration

DROP FUNCTION identity.session_delete(text);
DROP FUNCTION identity.session_update(text, jsonb);
DROP FUNCTION identity.session_touch(text, bigint);
DROP FUNCTION identity.session_create(text, jsonb, bigint, bigint);
DROP TABLE identity.sessions;
