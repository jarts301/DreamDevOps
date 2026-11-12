import { HttpErrorResponse } from '@angular/common/http';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BrowserNavigation } from '../core/browser-navigation';
import { type CurrentUser, SessionService } from '../core/session.service';
import { COMPANY_A, COMPANY_B, sampleUser, settle } from '../testing';
import { Shell } from './shell';

describe('Shell', () => {
  const navigation = { go: vi.fn() };
  const session = {
    current: sampleUser() as CurrentUser | null,
    user: () => session.current,
    can: (permission: string) => session.current?.permissions.includes(permission) ?? false,
    chooseCompany: vi.fn(async (_companyId: string) => {}),
    signOut: vi.fn(async () => {}),
  };

  const open = async (user: CurrentUser) => {
    session.current = user;
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: SessionService, useValue: session },
        { provide: BrowserNavigation, useValue: navigation },
      ],
    });
    const fixture = TestBed.createComponent(Shell);
    fixture.detectChanges();
    await settle();
    await fixture.whenStable();
    return fixture;
  };
  const element = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
  const menu = (fixture: ComponentFixture<unknown>) =>
    [...element(fixture).querySelectorAll('.nav-link')].map((link) => link.textContent?.trim());

  beforeEach(() => {
    navigation.go.mockClear();
    session.chooseCompany.mockClear();
    session.signOut.mockReset().mockResolvedValue(undefined);
  });

  it('shows a company member the company screens, and only those their permissions allow', async () => {
    const fixture = await open(sampleUser({ permissions: ['company-users:manage', 'audit:read'] }));

    expect(menu(fixture)).toEqual([
      'Overview',
      'Applications',
      'Builds',
      'Environments',
      'Hosting',
      'Blueprints',
      'Team',
      'Audit log',
      'Edition',
    ]);
    expect(element(fixture).textContent).toContain('Acme · Company Admin');
  });

  it('shows Monitoring and Alerts to members who view dashboards', async () => {
    const fixture = await open(sampleUser({ role: 'viewer', permissions: ['dashboards:view'] }));

    expect(menu(fixture)).toEqual([
      'Overview',
      'Applications',
      'Builds',
      'Environments',
      'Hosting',
      'Monitoring',
      'Alerts',
      'Blueprints',
      'Edition',
    ]);
    const link = (label: string) =>
      [...element(fixture).querySelectorAll('.nav-link')].find((candidate) => candidate.textContent?.trim() === label);
    expect(link('Monitoring')?.getAttribute('href')).toBe('/monitoring');
    expect(link('Alerts')?.getAttribute('href')).toBe('/alerts');
  });

  it('shows a platform admin the platform screens, and no company screens', async () => {
    const fixture = await open(
      sampleUser({
        companyId: null,
        companyName: null,
        role: null,
        memberships: [],
        permissions: ['audit:read-own', 'companies:manage', 'editions:manage'],
      }),
    );

    expect(menu(fixture)).toEqual(['Overview', 'Blueprints', 'Companies', 'Editions', 'My activity']);
    expect(element(fixture).textContent).toContain('No company');
  });

  it('switches company and reloads, so nothing from the previous company stays on screen', async () => {
    const fixture = await open(
      sampleUser({
        memberships: [
          { companyId: COMPANY_A, companyName: 'Acme', role: 'company-admin' },
          { companyId: COMPANY_B, companyName: 'Globex', role: 'developer' },
        ],
      }),
    );
    const select = element(fixture).querySelector('select')!;
    expect([...select.options].map((option) => option.textContent?.trim())).toEqual([
      'Acme (Company Admin)',
      'Globex (Developer)',
    ]);

    select.value = COMPANY_B;
    select.dispatchEvent(new Event('change'));
    await settle();

    expect(session.chooseCompany).toHaveBeenCalledWith(COMPANY_B);
    expect(navigation.go).toHaveBeenCalledWith('/');
  });

  it('explains a failed sign-out, and lets the person try again', async () => {
    session.signOut.mockRejectedValue(new HttpErrorResponse({ status: 0 }));
    const fixture = await open(sampleUser());
    const signOut = [...element(fixture).querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Sign out')!;

    signOut.click();
    await settle();
    fixture.detectChanges();

    expect(element(fixture).querySelector('[role="alert"]')?.textContent).toContain("We can't reach the server.");
    expect(signOut.disabled).toBe(false);
  });

  it('offers a way to skip to the content', async () => {
    const fixture = await open(sampleUser());

    expect(element(fixture).querySelector('.skip-link')?.getAttribute('href')).toBe('#main');
    expect(element(fixture).querySelector('main#main')).not.toBeNull();
  });
});
