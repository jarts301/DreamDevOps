-- Up Migration

-- Pull request checks run the platform's tests and secret scan, and build no image.
ALTER TABLE builds.builds DROP CONSTRAINT builds_kind_check;
ALTER TABLE builds.builds ADD CONSTRAINT builds_kind_check CHECK (kind IN ('feature', 'rc', 'final', 'check'));

-- Down Migration

DELETE FROM builds.builds WHERE kind = 'check';
ALTER TABLE builds.builds DROP CONSTRAINT builds_kind_check;
ALTER TABLE builds.builds ADD CONSTRAINT builds_kind_check CHECK (kind IN ('feature', 'rc', 'final'));
