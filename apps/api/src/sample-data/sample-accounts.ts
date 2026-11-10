/**
 * The sample company and accounts for local development: one person in each company
 * role, all with the same password, KEYCLOAK_DEV_USER_PASSWORD. Never used in production.
 */
export const SAMPLE_COMPANY_NAME = 'Dummy Company';

/** The Platform Admin, who creates the sample company, as a person would. */
export const SAMPLE_PLATFORM_ADMIN = 'dev-platform-admin';

export interface SampleAccount {
  readonly username: string;
  readonly firstName: string;
  readonly lastName: string;
  /** The role the account has in the sample company. */
  readonly role: 'company-admin' | 'tech-lead' | 'developer' | 'operator' | 'viewer';
}

/** The Company Admin comes first: the company's first member, who invites the rest. */
export const SAMPLE_ACCOUNTS: readonly SampleAccount[] = [
  { username: 'dev-company-admin', firstName: 'Dev', lastName: 'Company Admin', role: 'company-admin' },
  { username: 'dev-tech-lead', firstName: 'Dev', lastName: 'Tech Lead', role: 'tech-lead' },
  { username: 'dev-developer', firstName: 'Dev', lastName: 'Developer', role: 'developer' },
  { username: 'dev-operator', firstName: 'Dev', lastName: 'Operator', role: 'operator' },
  { username: 'dev-viewer', firstName: 'Dev', lastName: 'Viewer', role: 'viewer' },
];

export function sampleEmail(username: string): string {
  return `${username}@example.com`;
}
