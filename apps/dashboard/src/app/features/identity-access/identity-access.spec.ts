import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { BrowserNavigation } from '../../core/browser-navigation';
import { PendingInvitation, SESSION_STORAGE } from '../../core/pending-invitation';
import { SessionService } from '../../core/session.service';
import { COMPANY_A, sampleUser, settle } from '../../testing';
import { AcceptInvitation } from './accept-invitation';
import { invitationLink } from './identity-access.api';
import { StartCompany } from './start-company';
import { Team } from './team';

const ROLES = [
  { key: 'developer', name: 'Developer', permissions: [] },
  { key: 'company-admin', name: 'Company Admin', permissions: [] },
];
const SELF = { userId: 'user-1', email: 'person@example.com', displayName: 'Sample Person', role: 'company-admin', joinedAt: '2026-11-01T00:00:00Z' };
const OTHER = { userId: 'user-2', email: 'other@example.com', displayName: 'Other Person', role: 'developer', joinedAt: '2026-11-02T00:00:00Z' };

describe('identity and access screens', () => {
  let http: HttpTestingController;
  const navigation = { go: vi.fn() };

  beforeEach(() => {
    navigation.go.mockClear();
    const store = new Map<string, string>();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: BrowserNavigation, useValue: navigation },
        {
          provide: SESSION_STORAGE,
          useValue: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => store.set(key, value),
            removeItem: (key: string) => store.delete(key),
          },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const text = (fixture: ComponentFixture<unknown>) => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const button = (fixture: ComponentFixture<unknown>, label: string) =>
    [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
    )!;

  const render = async (fixture: ComponentFixture<unknown>) => {
    await settle();
    await fixture.whenStable();
  };

  /** Answers the requests made when the member and invitation lists refresh. */
  const answerLists = async (members: object[] = [SELF, OTHER], invitations: object[] = []) => {
    await settle();
    http.expectOne('/api/v1/company/members').flush(members);
    http.expectOne('/api/v1/company/invitations').flush(invitations);
  };

  describe('Team', () => {
    const openTeam = async () => {
      const fixture = TestBed.createComponent(Team);
      fixture.detectChanges();
      http.expectOne('/api/v1/company/roles').flush(ROLES);
      await answerLists();
      await render(fixture);
      return fixture;
    };

    it('shows members and role names', async () => {
      const fixture = await openTeam();

      expect(text(fixture)).toContain('Other Person');
      expect(text(fixture)).toContain('other@example.com');
      expect(text(fixture)).toContain('Company Admin');
      expect(text(fixture)).toContain('No open invitations.');
    });

    it('shows a failure from the API', async () => {
      const fixture = TestBed.createComponent(Team);
      fixture.detectChanges();
      http.expectOne('/api/v1/company/roles').flush({ title: 'Failed' }, { status: 500, statusText: 'Failed' });
      await render(fixture);

      expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')?.textContent).toContain('Failed');
    });

    it('changes a role', async () => {
      const fixture = await openTeam();
      const select = (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>(
        '[aria-label="Role of Other Person"]',
      )!;

      select.value = 'company-admin';
      select.dispatchEvent(new Event('change'));
      const request = http.expectOne('/api/v1/company/members/user-2');
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({ role: 'company-admin' });
      request.flush(null);
      await answerLists();
      await render(fixture);
    });

    it('puts the old role back when the API refuses the change', async () => {
      const fixture = await openTeam();
      const select = (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>(
        '[aria-label="Role of Sample Person"]',
      )!;

      select.value = 'developer';
      select.dispatchEvent(new Event('change'));
      http
        .expectOne('/api/v1/company/members/user-1')
        .flush({ detail: 'A company must keep at least one Company Admin.' }, { status: 409, statusText: 'Conflict' });
      await render(fixture);

      expect(select.value).toBe('company-admin');
      expect(text(fixture)).toContain('at least one Company Admin');
    });

    it('asks for confirmation before removing a member', async () => {
      const fixture = await openTeam();

      button(fixture, 'Remove Other Person').click();
      await render(fixture);
      http.expectNone('/api/v1/company/members/user-2');

      button(fixture, 'Confirm removal').click();
      const request = http.expectOne('/api/v1/company/members/user-2');
      expect(request.request.method).toBe('DELETE');
      request.flush(null);
      await answerLists([SELF]);
      await render(fixture);

      expect(text(fixture)).not.toContain('Other Person');
    });

    it('keeps the form from submitting an invalid email', async () => {
      const fixture = await openTeam();

      expect(button(fixture, 'Create invitation').disabled).toBe(true);
    });

    it('shows the invitation link once, then clears it from the form', async () => {
      const fixture = await openTeam();
      const email = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[type="email"]')!;
      email.value = 'new@example.com';
      email.dispatchEvent(new Event('input'));
      await render(fixture);

      button(fixture, 'Create invitation').click();
      const request = http.expectOne('/api/v1/company/invitations');
      expect(request.request.body).toEqual({ email: 'new@example.com', role: 'developer' });
      request.flush({ id: 'inv-1', token: 'secret-token', expiresAt: '2026-11-11T00:00:00Z' });
      await answerLists([SELF, OTHER], [{ id: 'inv-1', email: 'new@example.com', role: 'developer', expiresAt: '2026-11-11T00:00:00Z' }]);
      await render(fixture);

      const link = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('[aria-label="Invitation link"]');
      expect(link?.value).toBe(invitationLink('secret-token'));
      expect(email.value).toBe('');
      expect(text(fixture)).toContain('Revoke');
    });

    it('revokes an invitation', async () => {
      const fixture = TestBed.createComponent(Team);
      fixture.detectChanges();
      http.expectOne('/api/v1/company/roles').flush(ROLES);
      await answerLists([SELF], [{ id: 'inv-1', email: 'new@example.com', role: 'developer', expiresAt: '2026-11-11T00:00:00Z' }]);
      await render(fixture);

      button(fixture, 'Revoke invitation for new@example.com').click();
      const request = http.expectOne('/api/v1/company/invitations/inv-1');
      expect(request.request.method).toBe('DELETE');
      request.flush(null);
      await answerLists([SELF], []);
      await render(fixture);

      expect(text(fixture)).toContain('No open invitations.');
    });
  });

  describe('invitation links', () => {
    it('keep the token in the fragment, which browsers never send to a server', () => {
      const url = new URL(invitationLink('a token'));

      expect(url.pathname).toBe('/invitations/accept');
      expect(url.search).toBe('');
      expect(url.hash).toBe('#token=a%20token');
    });
  });

  describe('AcceptInvitation', () => {
    const open = async (user: object | null, token: string | null = 'secret-token') => {
      if (token !== null) {
        TestBed.inject(PendingInvitation).set(token);
      }
      const fixture = TestBed.createComponent(AcceptInvitation);
      fixture.detectChanges();
      if (token !== null) {
        const request = http.expectOne('/api/v1/auth/me');
        if (user === null) {
          request.flush({}, { status: 401, statusText: 'Unauthorized' });
        } else {
          request.flush(user);
        }
      }
      await render(fixture);
      return fixture;
    };

    it('explains a link with no token', async () => {
      const fixture = await open(null, null);

      expect(text(fixture)).toContain("isn't complete");
      expect(navigation.go).not.toHaveBeenCalled();
    });

    it('sends an anonymous user to login, keeping the token', async () => {
      await open(null);

      expect(navigation.go).toHaveBeenCalledWith('/api/v1/auth/login');
      expect(TestBed.inject(PendingInvitation).get()).toBe('secret-token');
    });

    it('does not join until the user clicks', async () => {
      const fixture = await open(sampleUser({ companyId: null, role: null, memberships: [] }));

      http.expectNone('/api/v1/invitations/accept');
      expect(text(fixture)).toContain('person@example.com');
    });

    it('joins, clears the token and goes to the overview', async () => {
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
      const fixture = await open(sampleUser({ companyId: null, role: null, memberships: [] }));

      button(fixture, 'Accept invitation').click();
      const request = http.expectOne('/api/v1/invitations/accept');
      expect(request.request.body).toEqual({ token: 'secret-token' });
      request.flush({ companyId: COMPANY_A, role: 'developer' });
      await settle();
      http.expectOne('/api/v1/auth/me').flush(sampleUser({ role: 'developer' }));
      await render(fixture);

      expect(TestBed.inject(PendingInvitation).get()).toBeNull();
      expect(navigate).toHaveBeenCalledWith('/');
    });

    it('explains a refusal and keeps the token for another account', async () => {
      const fixture = await open(sampleUser());

      button(fixture, 'Accept invitation').click();
      http
        .expectOne('/api/v1/invitations/accept')
        .flush({ detail: 'This invitation is not valid.' }, { status: 404, statusText: 'Not Found' });
      await render(fixture);

      expect(text(fixture)).toContain('This invitation is not valid.');
      expect(TestBed.inject(PendingInvitation).get()).toBe('secret-token');
      expect(button(fixture, 'Use another account')).toBeDefined();
    });

    it('forgets the invitation when declined', async () => {
      vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
      const fixture = await open(sampleUser());

      button(fixture, 'Not now').click();
      await render(fixture);

      expect(TestBed.inject(PendingInvitation).get()).toBeNull();
    });
  });

  describe('StartCompany', () => {
    it('invites a first admin to a new company', async () => {
      const fixture = TestBed.createComponent(StartCompany);
      fixture.detectChanges();
      await render(fixture);
      const email = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[type="email"]')!;
      email.value = 'founder@example.com';
      email.dispatchEvent(new Event('input'));
      await render(fixture);

      button(fixture, 'Create invitation').click();
      const request = http.expectOne((candidate) =>
        /^\/api\/v1\/platform\/companies\/[0-9a-f-]{36}\/first-admin-invitation$/.test(candidate.url),
      );
      expect(request.request.body).toEqual({ email: 'founder@example.com' });
      request.flush({ id: 'inv-1', token: 'secret-token', expiresAt: '2026-11-11T00:00:00Z' });
      await render(fixture);

      expect(text(fixture)).toContain('founder@example.com');
      expect(TestBed.inject(SessionService).user()).toBeNull();
    });
  });
});
