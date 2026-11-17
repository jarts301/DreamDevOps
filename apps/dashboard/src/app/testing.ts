import type { ComponentFixture } from '@angular/core/testing';
import type { CurrentUser } from './core/session.service';

export const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
export const COMPANY_B = '00000000-0000-4000-8000-00000000000b';

export const sampleUser = (overrides: Partial<CurrentUser> = {}): CurrentUser => ({
  userId: 'user-1',
  email: 'person@example.com',
  displayName: 'Sample Person',
  companyId: COMPANY_A,
  companyName: 'Acme',
  role: 'company-admin',
  permissions: ['company-users:manage', 'dashboards:view'],
  memberships: [{ companyId: COMPANY_A, companyName: 'Acme', role: 'company-admin' }],
  ...overrides,
});

/** Lets promises and Angular's rendering settle after answering a request. */
export async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve));
  }
}

/**
 * Answers the production confirmation panel: types the name and a reason, and presses its
 * button. Returns the panel's text, as people read it.
 */
export async function confirmProduction(fixture: ComponentFixture<unknown>, name: string, reason?: string): Promise<string> {
  await settle();
  await fixture.whenStable();
  const panel = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.production-confirmation');
  if (panel === null) {
    throw new Error('No production confirmation is shown.');
  }
  const typed = panel.querySelector<HTMLInputElement>('input')!;
  typed.value = name;
  typed.dispatchEvent(new Event('input'));
  if (reason !== undefined) {
    const why = panel.querySelector<HTMLTextAreaElement>('textarea')!;
    why.value = reason;
    why.dispatchEvent(new Event('input'));
  }
  await settle();
  await fixture.whenStable();
  const text = panel.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  panel.querySelector<HTMLButtonElement>('button.button-danger')!.click();
  await settle();
  return text;
}
