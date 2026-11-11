-- Up Migration

-- What each deployment's container may use at most, as its host started it, so people can
-- see how close what runs is to its limits. Null when the host sets none, or nothing
-- started, such as for a stop.
ALTER TABLE environments.deployments
  ADD COLUMN cpu_limit double precision CHECK (cpu_limit > 0),
  ADD COLUMN memory_limit_bytes bigint CHECK (memory_limit_bytes > 0);

GRANT UPDATE (cpu_limit, memory_limit_bytes) ON environments.deployments TO dreamdevops_app;

-- Deployments before this one ran on This machine, the only host that deploys so far,
-- which has always started every container with one CPU and 512 MiB of memory. Row-level
-- security hides every company's rows from the tables' owner, so it's lifted for this
-- update only, inside this migration's transaction.
ALTER TABLE environments.deployments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE environments.targets NO FORCE ROW LEVEL SECURITY;

UPDATE environments.deployments d
SET cpu_limit = 1, memory_limit_bytes = 536870912
FROM environments.targets t
WHERE t.id = d.target_id AND t.provider = 'local' AND d.kind <> 'stop' AND d.status = 'succeeded';

ALTER TABLE environments.deployments FORCE ROW LEVEL SECURITY;
ALTER TABLE environments.targets FORCE ROW LEVEL SECURITY;

-- Down Migration

REVOKE UPDATE (cpu_limit, memory_limit_bytes) ON environments.deployments FROM dreamdevops_app;
ALTER TABLE environments.deployments DROP COLUMN memory_limit_bytes, DROP COLUMN cpu_limit;
