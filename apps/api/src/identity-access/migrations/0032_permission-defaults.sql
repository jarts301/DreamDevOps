-- Up Migration

-- Identity and access gives roles the permissions each context declares for them by default,
-- in the contracts, when the API starts. It only adds them: removing one stays a migration.
GRANT SELECT ON identity.roles TO dreamdevops_identity;
GRANT SELECT, INSERT ON identity.role_permissions TO dreamdevops_identity;

-- Down Migration

REVOKE INSERT ON identity.role_permissions FROM dreamdevops_identity;
