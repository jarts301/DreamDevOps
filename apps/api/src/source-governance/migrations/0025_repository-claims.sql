-- Up Migration

-- Who is creating a repository now. A job claims it for a short while, renews the claim
-- as long as it works with Git, and clears it when done. Git calls no longer happen while
-- a row lock, and with it a database connection, is held. If the job's process dies, the
-- claim runs out soon, and the next try takes over.
ALTER TABLE source.repositories ADD COLUMN claimed_until timestamptz;
GRANT UPDATE (claimed_until) ON source.repositories TO dreamdevops_app;

-- Down Migration

REVOKE UPDATE (claimed_until) ON source.repositories FROM dreamdevops_app;
ALTER TABLE source.repositories DROP COLUMN claimed_until;
