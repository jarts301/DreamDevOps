-- Up Migration

-- Variable and secret names may now use lower case, as containers allow, and values are
-- up to 32 KB. The API checks the rest: one line, and limits for each scope.
ALTER TABLE environments.variables DROP CONSTRAINT variables_name_check;
ALTER TABLE environments.variables DROP CONSTRAINT variables_value_check;
ALTER TABLE environments.variables
  ADD CONSTRAINT variables_name_check CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  ADD CONSTRAINT variables_value_check CHECK (octet_length(value) <= 32768);

ALTER TABLE environments.secrets DROP CONSTRAINT secrets_name_check;
ALTER TABLE environments.secrets
  ADD CONSTRAINT secrets_name_check CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  -- The value is only in OpenBao; its size is kept, so each scope's total can be checked.
  ADD COLUMN value_bytes integer NOT NULL DEFAULT 0 CHECK (value_bytes BETWEEN 0 AND 32768);

-- Two names that differ only in case would confuse people, so one scope can't hold both.
DROP INDEX environments.variables_name_idx;
CREATE UNIQUE INDEX variables_name_idx ON environments.variables
  (environment_id, coalesce(application_id, '00000000-0000-0000-0000-000000000000'), upper(name));
DROP INDEX environments.secrets_name_idx;
CREATE UNIQUE INDEX secrets_name_idx ON environments.secrets
  (environment_id, coalesce(application_id, '00000000-0000-0000-0000-000000000000'), upper(name));

-- Down Migration

DROP INDEX environments.secrets_name_idx;
CREATE UNIQUE INDEX secrets_name_idx ON environments.secrets
  (environment_id, coalesce(application_id, '00000000-0000-0000-0000-000000000000'), name);
DROP INDEX environments.variables_name_idx;
CREATE UNIQUE INDEX variables_name_idx ON environments.variables
  (environment_id, coalesce(application_id, '00000000-0000-0000-0000-000000000000'), name);
ALTER TABLE environments.secrets DROP COLUMN value_bytes;
ALTER TABLE environments.secrets DROP CONSTRAINT secrets_name_check;
ALTER TABLE environments.secrets ADD CONSTRAINT secrets_name_check CHECK (name ~ '^[A-Z_][A-Z0-9_]{0,99}$');
ALTER TABLE environments.variables DROP CONSTRAINT variables_value_check;
ALTER TABLE environments.variables DROP CONSTRAINT variables_name_check;
ALTER TABLE environments.variables
  ADD CONSTRAINT variables_name_check CHECK (name ~ '^[A-Z_][A-Z0-9_]{0,99}$'),
  ADD CONSTRAINT variables_value_check CHECK (length(value) <= 4096);
