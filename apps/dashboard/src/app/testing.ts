import type { CurrentUser } from './core/session.service';

export const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
export const COMPANY_B = '00000000-0000-4000-8000-00000000000b';

export const sampleUser = (overrides: Partial<CurrentUser> = {}): CurrentUser => ({
  userId: 'user-1',
  email: 'person@example.com',
  displayName: 'Sample Person',
  companyId: COMPANY_A,
  role: 'company-admin',
  permissions: ['company-users:manage', 'dashboards:view'],
  memberships: [{ companyId: COMPANY_A, role: 'company-admin' }],
  ...overrides,
});

/** Lets promises and Angular's rendering settle after answering a request. */
export async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve));
  }
}
