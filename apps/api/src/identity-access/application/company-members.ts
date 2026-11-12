/** Provides CompanyMembers to other contexts. */
export const COMPANY_MEMBERS = Symbol('COMPANY_MEMBERS');

/** A member of the current company, as other contexts may know them. */
export interface CompanyMember {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: string;
}

/**
 * Identity's published read model of who belongs to the current company now. Someone
 * removed from the company isn't found, so contexts that reach people, such as Alerts,
 * ask here just before they do, rather than keeping addresses of their own.
 */
export interface CompanyMembers {
  /** Every member, by name. */
  list(): Promise<CompanyMember[]>;
  /** Those of these users who are members now. Anyone else is left out. */
  find(userIds: readonly string[]): Promise<CompanyMember[]>;
}
