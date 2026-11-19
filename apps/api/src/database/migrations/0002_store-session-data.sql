-- Up Migration

-- Sessions now hold only who is signed in. Permissions are read on each request,
-- so removing someone's access takes effect at once. Older sessions don't fit this
-- shape, so they are ended.
DELETE FROM api.sessions;
ALTER TABLE api.sessions RENAME COLUMN principal TO data;

DROP FUNCTION api.session_touch(text, bigint);
DROP FUNCTION api.session_create(text, jsonb, bigint, bigint);

CREATE FUNCTION api.session_create(
  p_id_hash text,
  p_data jsonb,
  p_absolute_ms bigint,
  p_idle_ms bigint
) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = ''
  AS $$
    DELETE FROM api.sessions WHERE expires_at <= now() OR idle_expires_at <= now();
    INSERT INTO api.sessions (id_hash, data, expires_at, idle_expires_at)
    VALUES (
      p_id_hash,
      p_data,
      now() + p_absolute_ms * interval '1 millisecond',
      now() + p_idle_ms * interval '1 millisecond'
    );
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

REVOKE ALL ON FUNCTION api.session_create(text, jsonb, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.session_touch(text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.session_update(text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION api.session_create(text, jsonb, bigint, bigint) TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION api.session_touch(text, bigint) TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION api.session_update(text, jsonb) TO dreamdevops_app;

-- Down Migration

DELETE FROM api.sessions;
DROP FUNCTION api.session_update(text, jsonb);
DROP FUNCTION api.session_touch(text, bigint);
DROP FUNCTION api.session_create(text, jsonb, bigint, bigint);
ALTER TABLE api.sessions RENAME COLUMN data TO principal;

CREATE FUNCTION api.session_create(
  p_id_hash text,
  p_principal jsonb,
  p_absolute_ms bigint,
  p_idle_ms bigint
) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = ''
  AS $$
    DELETE FROM api.sessions WHERE expires_at <= now() OR idle_expires_at <= now();
    INSERT INTO api.sessions (id_hash, principal, expires_at, idle_expires_at)
    VALUES (
      p_id_hash,
      p_principal,
      now() + p_absolute_ms * interval '1 millisecond',
      now() + p_idle_ms * interval '1 millisecond'
    );
  $$;

CREATE FUNCTION api.session_touch(p_id_hash text, p_idle_ms bigint) RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = ''
  AS $$
    UPDATE api.sessions
    SET idle_expires_at = LEAST(expires_at, now() + p_idle_ms * interval '1 millisecond')
    WHERE id_hash = p_id_hash AND expires_at > now() AND idle_expires_at > now()
    RETURNING principal;
  $$;

REVOKE ALL ON FUNCTION api.session_create(text, jsonb, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.session_touch(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.session_create(text, jsonb, bigint, bigint) TO dreamdevops_app;
GRANT EXECUTE ON FUNCTION api.session_touch(text, bigint) TO dreamdevops_app;
