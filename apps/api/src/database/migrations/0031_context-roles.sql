-- Up Migration

-- Each bounded context works as its own database role, with rights on its own schema only,
-- so the database refuses a query that strays into another context's tables, as the
-- architecture test already refuses one it can read. The roles are made by the platform's
-- database setup, init-platform-database.sql, as only it may create roles. The application
-- switches to a context's role, with SET LOCAL ROLE, for that context's work.
--
-- For each context's schema, this moves to the context's role what the application's role
-- may do there: its tables and columns, its functions, and the row-level security policies
-- that let it see one company's rows. The application's role keeps nothing there. Each
-- role also gets what every context needs from the shared kernel: the outbox, and the
-- function that says which company the transaction is for.
DO $$
DECLARE
  context record;
  item record;
  missing text[];
BEGIN
  CREATE TEMPORARY TABLE context_roles (schema_name text PRIMARY KEY, role_name text NOT NULL) ON COMMIT DROP;
  INSERT INTO context_roles VALUES
    ('identity', 'dreamdevops_identity'), ('tenancy', 'dreamdevops_tenancy'), ('audit', 'dreamdevops_audit'),
    ('notification', 'dreamdevops_notification'), ('editions', 'dreamdevops_editions'), ('catalog', 'dreamdevops_catalog'),
    ('source', 'dreamdevops_source'), ('webhooks', 'dreamdevops_webhooks'), ('builds', 'dreamdevops_builds'),
    ('releases', 'dreamdevops_releases'), ('environments', 'dreamdevops_environments'),
    ('deployments', 'dreamdevops_deployments'), ('alerts', 'dreamdevops_alerts');

  SELECT array_agg(role_name) INTO missing FROM context_roles WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'The database roles % are missing. Run infra/local/postgres/init-platform-database.sql again, as the local stack does when it starts.', missing;
  END IF;

  FOR context IN SELECT * FROM context_roles LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I, kernel TO %I', context.schema_name, context.role_name);

    -- Whole-table rights, then rights on single columns, such as UPDATE of some columns only.
    FOR item IN
      SELECT table_schema, table_name, string_agg(privilege_type, ', ') AS privileges
      FROM information_schema.role_table_grants
      WHERE grantee = 'dreamdevops_app' AND table_schema IN (context.schema_name, 'kernel')
      GROUP BY table_schema, table_name
    LOOP
      EXECUTE format('GRANT %s ON %I.%I TO %I', item.privileges, item.table_schema, item.table_name, context.role_name);
    END LOOP;
    FOR item IN
      SELECT c.table_schema, c.table_name, c.privilege_type, string_agg(format('%I', c.column_name), ', ') AS columns
      FROM information_schema.column_privileges c
      WHERE c.grantee = 'dreamdevops_app' AND c.table_schema = context.schema_name
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.role_table_grants t
          WHERE t.grantee = 'dreamdevops_app' AND t.table_schema = c.table_schema
            AND t.table_name = c.table_name AND t.privilege_type = c.privilege_type
        )
      GROUP BY c.table_schema, c.table_name, c.privilege_type
    LOOP
      EXECUTE format('GRANT %s (%s) ON %I.%I TO %I', item.privilege_type, item.columns, item.table_schema, item.table_name, context.role_name);
    END LOOP;

    -- Functions, including those that read another schema as their owner.
    FOR item IN
      SELECT p.oid::regprocedure AS function
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = context.schema_name AND has_function_privilege('dreamdevops_app', p.oid, 'EXECUTE')
    LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', item.function, context.role_name);
    END LOOP;
    EXECUTE format('GRANT EXECUTE ON FUNCTION kernel.current_company_id() TO %I', context.role_name);

    -- Policies that applied to the application's role apply to the context's role instead.
    FOR item IN
      SELECT schemaname, tablename, policyname, roles FROM pg_policies
      WHERE schemaname = context.schema_name AND 'dreamdevops_app' = ANY (roles)
    LOOP
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I TO %s',
        item.policyname, item.schemaname, item.tablename,
        (SELECT string_agg(format('%I', CASE WHEN r = 'dreamdevops_app' THEN context.role_name ELSE r END), ', ') FROM unnest(item.roles) AS r)
      );
    END LOOP;
  END LOOP;

  -- The kernel's policies, such as the outbox's, apply to every context's role too.
  FOR item IN SELECT tablename, policyname, roles FROM pg_policies WHERE schemaname = 'kernel' AND 'dreamdevops_app' = ANY (roles) LOOP
    EXECUTE format(
      'ALTER POLICY %I ON kernel.%I TO %s',
      item.policyname, item.tablename,
      (SELECT string_agg(format('%I', r), ', ') FROM (SELECT unnest(item.roles) AS r UNION SELECT role_name FROM context_roles) AS roles)
    );
  END LOOP;

  -- The application's role keeps nothing in the contexts' schemas.
  FOR context IN SELECT * FROM context_roles LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM dreamdevops_app', context.schema_name);
    EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA %I FROM dreamdevops_app', context.schema_name);
    EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM dreamdevops_app', context.schema_name);
  END LOOP;
END
$$;

-- Down Migration

-- Gives the application's role back what the contexts' roles may do, and takes it from them.
-- The roles stay, as the platform's database setup made them.
DO $$
DECLARE
  context record;
  item record;
BEGIN
  CREATE TEMPORARY TABLE context_roles (schema_name text PRIMARY KEY, role_name text NOT NULL) ON COMMIT DROP;
  INSERT INTO context_roles VALUES
    ('identity', 'dreamdevops_identity'), ('tenancy', 'dreamdevops_tenancy'), ('audit', 'dreamdevops_audit'),
    ('notification', 'dreamdevops_notification'), ('editions', 'dreamdevops_editions'), ('catalog', 'dreamdevops_catalog'),
    ('source', 'dreamdevops_source'), ('webhooks', 'dreamdevops_webhooks'), ('builds', 'dreamdevops_builds'),
    ('releases', 'dreamdevops_releases'), ('environments', 'dreamdevops_environments'),
    ('deployments', 'dreamdevops_deployments'), ('alerts', 'dreamdevops_alerts');

  FOR context IN SELECT * FROM context_roles LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO dreamdevops_app', context.schema_name);
    FOR item IN
      SELECT table_name, string_agg(privilege_type, ', ') AS privileges
      FROM information_schema.role_table_grants
      WHERE grantee = context.role_name AND table_schema = context.schema_name
      GROUP BY table_name
    LOOP
      EXECUTE format('GRANT %s ON %I.%I TO dreamdevops_app', item.privileges, context.schema_name, item.table_name);
    END LOOP;
    FOR item IN
      SELECT c.table_name, c.privilege_type, string_agg(format('%I', c.column_name), ', ') AS columns
      FROM information_schema.column_privileges c
      WHERE c.grantee = context.role_name AND c.table_schema = context.schema_name
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.role_table_grants t
          WHERE t.grantee = context.role_name AND t.table_schema = c.table_schema
            AND t.table_name = c.table_name AND t.privilege_type = c.privilege_type
        )
      GROUP BY c.table_name, c.privilege_type
    LOOP
      EXECUTE format('GRANT %s (%s) ON %I.%I TO dreamdevops_app', item.privilege_type, item.columns, context.schema_name, item.table_name);
    END LOOP;
    FOR item IN
      SELECT p.oid::regprocedure AS function
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = context.schema_name AND has_function_privilege(context.role_name, p.oid, 'EXECUTE')
    LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO dreamdevops_app', item.function);
    END LOOP;
    FOR item IN
      SELECT schemaname, tablename, policyname, roles FROM pg_policies
      WHERE schemaname = context.schema_name AND context.role_name = ANY (roles)
    LOOP
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I TO %s',
        item.policyname, item.schemaname, item.tablename,
        (SELECT string_agg(format('%I', CASE WHEN r = context.role_name THEN 'dreamdevops_app' ELSE r END), ', ') FROM unnest(item.roles) AS r)
      );
    END LOOP;
  END LOOP;

  FOR item IN SELECT tablename, policyname, roles FROM pg_policies WHERE schemaname = 'kernel' LOOP
    EXECUTE format(
      'ALTER POLICY %I ON kernel.%I TO %s',
      item.policyname, item.tablename,
      (SELECT string_agg(format('%I', r), ', ') FROM unnest(item.roles) AS r WHERE r NOT IN (SELECT role_name FROM context_roles))
    );
  END LOOP;

  FOR context IN SELECT * FROM context_roles LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I, kernel FROM %I', context.schema_name, context.role_name);
    EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA %I, kernel FROM %I', context.schema_name, context.role_name);
    EXECUTE format('REVOKE USAGE ON SCHEMA %I, kernel FROM %I', context.schema_name, context.role_name);
  END LOOP;
END
$$;
