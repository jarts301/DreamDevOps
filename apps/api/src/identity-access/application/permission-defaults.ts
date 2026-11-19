import type { PermissionGrant } from '@dreamdevops/contracts/permissions';
import type { Logger } from '@dreamdevops/shared-kernel';
import type { PermissionStore, RolePermission } from './ports.ts';

/**
 * Gives roles the permissions each context declares for them by default, in its contracts,
 * so a context's new permission reaches its roles without a migration of Identity's. It only
 * ever adds: a permission someone took from a role stays taken until Identity's own migration
 * says otherwise, so what a role may do never changes without someone deciding it.
 */
export class PermissionDefaults {
  readonly #store: PermissionStore;
  readonly #declared: readonly PermissionGrant[];
  readonly #logger: Logger;

  constructor(store: PermissionStore, declared: readonly PermissionGrant[], logger: Logger) {
    this.#store = store;
    this.#declared = declared;
    this.#logger = logger;
  }

  /** Adds the defaults missing. Safe to run on every start. */
  async apply(): Promise<RolePermission[]> {
    const grants = this.#declared.flatMap(({ permission, roles }) => roles.map((role) => ({ role, permission })));
    const added = await this.#store.addMissing(grants);
    if (added.length > 0) {
      this.#logger.log(`Gave roles their new permissions: ${added.map(({ role, permission }) => `${permission} to ${role}`).join(', ')}.`);
    }
    return added;
  }
}
