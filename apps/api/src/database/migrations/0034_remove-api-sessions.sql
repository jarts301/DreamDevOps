-- Up Migration

-- Login sessions are Identity and access's now, in its own schema, since 0033. The platform's
-- copies go, with the sessions in them, which end: people sign in once more.
DROP FUNCTION api.session_delete(text);
DROP FUNCTION api.session_update(text, jsonb);
DROP FUNCTION api.session_touch(text, bigint);
DROP FUNCTION api.session_create(text, jsonb, bigint, bigint);
DROP TABLE api.sessions;

-- Down Migration

-- Puts back the platform's sessions as 0002 left them, empty.
CREATE TABLE api.sessions (
  id_hash text PRIMARY KEY,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expires_at_idx ON api.sessions (expires_at);
CREATE FUNCTION api.session_create(p_id_hash text, p_data jsonb, p_absolute_ms bigint, p_idle_ms bigint) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = ''
  AS $$
    DELETE FROM api.sessions WHERE expires_at <= now() OR idle_expires_at <= now();
    INSERT INTO api.sessions (id_hash, data, expires_at, idle_expires_at)
    VALUES (p_id_hash, p_data, now() + p_absolute_ms * interval '1 millisecond', now() + p_idle_ms * interval '1 millisecond');
  $$;
CREATE FUNCTION api.session_touch(p_id_hash text, p_idle_ms bigint) RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = ''
  AS $$
    UPDATE api.sessions
    SET idle_expires_at = LEAST(expires_at, now() + p_idle_ms * interval '1 millisecond')
    WHERE id_hash = p_id_hash AND expires_at > now() AND idle_expires_at > now()
    RETURNING data;
  $$;
CREATE FUNCTION api.session_update(p_id_hash text, p_data jsonb) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = ''
  AS $$
    UPDATE api.sessions SET data = p_data WHERE id_hash = p_id_hash;
  $$;
CREATE FUNCTION api.session_delete(p_id_hash text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = ''
  AS $$
    DELETE FROM api.sessions WHERE id_hash = p_id_hash;
  $$;
REVOKE ALL ON FUNCTION api.session_create(text, jsonb, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.session_touch(text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.session_update(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.session_delete(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.session_create(text, jsonb, bigint, bigint) TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION api.session_touch(text, bigint) TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION api.session_update(text, jsonb) TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION api.session_delete(text) TO dreamdevops_app;
