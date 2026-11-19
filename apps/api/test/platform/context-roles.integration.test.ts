import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../test-database.ts';

/**
 * Each bounded context works as its own database role, with rights on its own schema only,
 * so the database refuses what the architecture test refuses in the code: a context reading
 * or writing another context's tables. These check it against a database set up as the
 * platform's is.
 */

/** Each context's schema and role, as init-platform-database.sql and the 0031 migration make them. */
const CONTEXT_ROLES: Readonly<Record<string, string>> = {
  identity: 'dreamdevops_identity',
  tenancy: 'dreamdevops_tenancy',
  audit: 'dreamdevops_audit',
  notification: 'dreamdevops_notification',
  editions: 'dreamdevops_editions',
  catalog: 'dreamdevops_catalog',
  source: 'dreamdevops_source',
  webhooks: 'dreamdevops_webhooks',
  builds: 'dreamdevops_builds',
  releases: 'dreamdevops_releases',
  environments: 'dreamdevops_environments',
  deployments: 'dreamdevops_deployments',
  alerts: 'dreamdevops_alerts',
};

let database: TestDatabase;
/** A table of each schema, to try reading. */
const tableOf = new Map<string, string>();

beforeAll(async () => {
  database = await startTestDatabase();
  const superuser = new pg.Pool({ connectionString: database.superuserUrl() });
  try {
    const { rows } = await superuser.query<{ schema: string; table: string }>(
      `SELECT DISTINCT ON (table_schema) table_schema AS schema, table_name AS table
       FROM information_schema.tables WHERE table_schema = ANY ($1) ORDER BY table_schema, table_name`,
      [Object.keys(CONTEXT_ROLES)],
    );
    for (const row of rows) {
      tableOf.set(row.schema, `${row.schema}.${row.table}`);
    }
  } finally {
    await superuser.end();
  }
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

/** What happens to a query, run as the application's login switched to a role, or not switched. */
async function attempt(role: string | null, sql: string): Promise<'allowed' | string> {
  const client = new pg.Client({ connectionString: database.urlFor('app') });
  await client.connect();
  try {
    await client.query('BEGIN');
    if (role !== null) {
      await client.query(`SET LOCAL ROLE ${role}`);
    }
    await client.query(sql);
    return 'allowed';
  } catch (error) {
    return (error as Error).message;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

describe("each context's database role", () => {
  it('has a table to try in every context schema', () => {
    expect([...tableOf.keys()].sort()).toEqual(Object.keys(CONTEXT_ROLES).sort());
  });

  it.each(Object.entries(CONTEXT_ROLES))('lets %s’s role read its own schema, and refuses every other context’s', async (schema, role) => {
    expect(await attempt(role, `SELECT 1 FROM ${tableOf.get(schema)} LIMIT 0`)).toBe('allowed');

    const others = Object.keys(CONTEXT_ROLES).filter((other) => other !== schema);
    const outcomes = await Promise.all(others.map(async (other) => [other, await attempt(role, `SELECT 1 FROM ${tableOf.get(other)} LIMIT 0`)]));

    expect(outcomes).toEqual(others.map((other) => [other, `permission denied for schema ${other}`]));
  });

  it('gives the application’s own login nothing in any context schema until it switches to that context’s role', async () => {
    const outcomes = await Promise.all(
      Object.keys(CONTEXT_ROLES).map(async (schema) => [schema, await attempt(null, `SELECT 1 FROM ${tableOf.get(schema)} LIMIT 0`)]),
    );

    expect(outcomes).toEqual(Object.keys(CONTEXT_ROLES).map((schema) => [schema, `permission denied for schema ${schema}`]));
  });

  it('can’t be used to log in', async () => {
    const pool = new pg.Pool({ connectionString: database.superuserUrl() });
    try {
      const { rows } = await pool.query<{ rolname: string }>('SELECT rolname FROM pg_roles WHERE rolname = ANY ($1) AND rolcanlogin', [
        Object.values(CONTEXT_ROLES),
      ]);
      expect(rows).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('is one the application may switch to, without holding its rights', async () => {
    const pool = new pg.Pool({ connectionString: database.superuserUrl() });
    try {
      const { rows } = await pool.query<{ role: string; inherits: boolean; switches: boolean }>(
        `SELECT r.rolname AS role, m.inherit_option AS inherits, m.set_option AS switches
         FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles a ON a.oid = m.member
         WHERE a.rolname = 'dreamdevops_app' AND r.rolname = ANY ($1) ORDER BY 1`,
        [Object.values(CONTEXT_ROLES)],
      );
      expect(rows).toEqual(Object.values(CONTEXT_ROLES).sort().map((role) => ({ role, inherits: false, switches: true })));
    } finally {
      await pool.end();
    }
  });
});
