-- Up Migration

-- Who is setting up a company's resource now, such as its Git organization. A job claims
-- it for a short while, renews the claim as long as it works with Git, and clears it when
-- done, so Git calls no longer happen while the company's row, and a database connection,
-- is held. If the job's process dies, the claim runs out soon, and the next try takes over.
ALTER TABLE tenancy.company_resources ADD COLUMN claimed_until timestamptz;
GRANT UPDATE (claimed_until) ON tenancy.company_resources TO dreamdevops_app;

-- Down Migration

REVOKE UPDATE (claimed_until) ON tenancy.company_resources FROM dreamdevops_app;
ALTER TABLE tenancy.company_resources DROP COLUMN claimed_until;
