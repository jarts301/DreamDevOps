import type { Queryable } from '@dreamdevops/shared-kernel/postgres';
import type { PermissionStore, RolePermission } from '../application/ports.ts';

/** Each role's permissions, in the identity schema, which hold for every company. */
export class PostgresPermissionStore implements PermissionStore {
  readonly #database: Queryable;

  constructor(database: Queryable) {
    this.#database = database;
  }

  async addMissing(grants: readonly RolePermission[]): Promise<RolePermission[]> {
    const { rows } = await this.#database.query<RolePermission>(
      `INSERT INTO identity.role_permissions (role_key, permission)
       SELECT g.role, g.permission
       FROM unnest($1::text[], $2::text[]) AS g (role, permission)
       WHERE EXISTS (SELECT 1 FROM identity.roles r WHERE r.key = g.role)
       ON CONFLICT DO NOTHING
       RETURNING role_key AS role, permission`,
      [grants.map(({ role }) => role), grants.map(({ permission }) => permission)],
    );
    return rows;
  }
}
