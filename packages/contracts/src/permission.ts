/**
 * A permission a context checks, and the roles that have it until someone decides otherwise.
 * Each context declares its own in its permissions.ts. Identity and access, which keeps every
 * role's permissions, adds those missing when it starts, and never removes one: taking a
 * permission away from a role is a decision, made in a migration of Identity's.
 */
export interface PermissionGrant {
  /** Written as "subject:action", such as "releases:start". */
  readonly permission: string;
  /** The roles that have it by default, by key, such as tech-lead or platform-admin. */
  readonly roles: readonly string[];
}
