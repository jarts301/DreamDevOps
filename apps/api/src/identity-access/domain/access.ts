import { createMongoAbility } from '@casl/ability';

export interface CompanyMembership {
  readonly companyId: string;
  readonly companyName: string;
  readonly role: string;
  readonly permissions: readonly string[];
}

/** Everything a user can do, across all their companies. */
export interface UserAccess {
  readonly userId: string;
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName: string;
  readonly platformPermissions: readonly string[];
  readonly memberships: readonly CompanyMembership[];
}

/** The signed-in user for one request, acting for at most one company. */
export interface Principal {
  readonly userId: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName: string;
  readonly companyId: string | null;
  readonly companyName: string | null;
  readonly role: string | null;
  readonly permissions: readonly string[];
  readonly memberships: readonly { readonly companyId: string; readonly companyName: string; readonly role: string }[];
}

/**
 * Works out what a user can do right now. The chosen company applies only while the
 * user is still a member. Otherwise it falls back to their oldest membership, so a
 * removed member loses access at once.
 */
export function toPrincipal(access: UserAccess, chosenCompanyId: string | null): Principal {
  const active =
    access.memberships.find((membership) => membership.companyId === chosenCompanyId) ?? access.memberships[0];

  return {
    userId: access.userId,
    email: access.email,
    emailVerified: access.emailVerified,
    displayName: access.displayName,
    companyId: active?.companyId ?? null,
    companyName: active?.companyName ?? null,
    role: active?.role ?? null,
    permissions: [...new Set([...access.platformPermissions, ...(active?.permissions ?? [])])],
    memberships: access.memberships.map(({ companyId, companyName, role }) => ({ companyId, companyName, role })),
  };
}

/** Permissions are written as "subject:action", such as "releases:start". */
export function hasPermissions(principal: Principal, required: readonly string[]): boolean {
  const ability = createMongoAbility(
    principal.permissions.map((permission) => {
      const [subject = '', action = ''] = permission.split(':');
      return { action, subject };
    }),
  );
  return required.every((permission) => {
    const [subject = '', action = ''] = permission.split(':');
    return ability.can(action, subject);
  });
}
