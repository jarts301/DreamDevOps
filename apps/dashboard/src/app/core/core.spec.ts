import { HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type UrlTree } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { COMPANY_B, sampleUser, settle } from '../testing';
import { errorMessage } from './api-error';
import { BrowserNavigation } from './browser-navigation';
import { authGuard, companyGuard, permissionGuard } from './guards';
import { permissionDescription, roleName } from './labels';
import { PendingInvitation, SESSION_STORAGE } from './pending-invitation';
import { sessionExpiredInterceptor } from './session-expired.interceptor';
import { SessionService } from './session.service';

describe('core', () => {
  let http: HttpTestingController;
  let session: SessionService;
  const navigation = { go: vi.fn() };

  const answerMe = (body: object | null) => {
    const request = http.expectOne('/api/v1/auth/me');
    if (body === null) {
      request.flush({ status: 401 }, { status: 401, statusText: 'Unauthorized' });
    } else {
      request.flush(body);
    }
  };

  const runGuard = (guard: typeof authGuard) =>
    TestBed.runInInjectionContext(() => guard({} as never, {} as never)) as Promise<boolean | UrlTree>;

  beforeEach(() => {
    navigation.go.mockClear();
    const store = new Map<string, string>();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([sessionExpiredInterceptor])),
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
    session = TestBed.inject(SessionService);
  });

  afterEach(() => http.verify());

  describe('SessionService', () => {
    it('loads the signed-in user once', async () => {
      const first = session.load();
      answerMe(sampleUser());

      await expect(first).resolves.toMatchObject({ email: 'person@example.com' });
      await expect(session.load()).resolves.toMatchObject({ email: 'person@example.com' });
    });

    it('treats 401 as signed out, not as a failure', async () => {
      const loading = session.load();
      answerMe(null);

      await expect(loading).resolves.toBeNull();
      expect(session.user()).toBeNull();
    });

    it('passes on other failures', async () => {
      const loading = session.load();
      http.expectOne('/api/v1/auth/me').flush({}, { status: 500, statusText: 'Failed' });

      await expect(loading).rejects.toBeInstanceOf(HttpErrorResponse);
    });

    it('answers permission checks from the API response', async () => {
      const loading = session.load();
      answerMe(sampleUser({ permissions: ['releases:start'] }));
      await loading;

      expect(session.can('releases:start')).toBe(true);
      expect(session.can('company-users:manage')).toBe(false);
    });

    it('reloads after choosing a company', async () => {
      const choosing = session.chooseCompany(COMPANY_B);
      const request = http.expectOne('/api/v1/auth/active-company');
      expect(request.request.body).toEqual({ companyId: COMPANY_B });
      request.flush(null);
      await settle();
      answerMe(sampleUser({ companyId: COMPANY_B }));

      await choosing;
      expect(session.user()?.companyId).toBe(COMPANY_B);
    });

    it('sends the browser to the login provider to finish signing out', async () => {
      const signingOut = session.signOut();
      http.expectOne('/api/v1/auth/logout').flush({ logoutUrl: 'http://login.test/logout' });

      await signingOut;

      expect(session.user()).toBeNull();
      expect(navigation.go).toHaveBeenCalledWith('http://login.test/logout');
    });
  });

  describe('authGuard', () => {
    it('allows a signed-in user', async () => {
      const result = runGuard(authGuard);
      answerMe(sampleUser());

      await expect(result).resolves.toBe(true);
      expect(navigation.go).not.toHaveBeenCalled();
    });

    it('sends an anonymous user to login', async () => {
      const result = runGuard(authGuard);
      answerMe(null);

      await expect(result).resolves.toBe(false);
      expect(navigation.go).toHaveBeenCalledWith('/api/v1/auth/login');
    });

    it('returns to a pending invitation after login', async () => {
      TestBed.inject(PendingInvitation).set('token');

      const result = runGuard(authGuard);
      answerMe(sampleUser());

      expect(TestBed.inject(Router).serializeUrl((await result) as UrlTree)).toBe('/invitations/accept');
    });
  });

  describe('permissionGuard', () => {
    it('allows a user with the permission', async () => {
      const result = runGuard(permissionGuard('company-users:manage'));
      answerMe(sampleUser());

      await expect(result).resolves.toBe(true);
    });

    it('redirects a user without the permission', async () => {
      const result = runGuard(permissionGuard('companies:manage'));
      answerMe(sampleUser());

      expect(TestBed.inject(Router).serializeUrl((await result) as UrlTree)).toBe('/not-allowed');
    });
  });

  describe('companyGuard', () => {
    it('allows a user who acts for a company', async () => {
      const result = runGuard(companyGuard);
      answerMe(sampleUser());

      await expect(result).resolves.toBe(true);
    });

    it('redirects a user with no company', async () => {
      const result = runGuard(companyGuard);
      answerMe(sampleUser({ companyId: null, companyName: null, role: null, memberships: [] }));

      expect(TestBed.inject(Router).serializeUrl((await result) as UrlTree)).toBe('/not-allowed');
    });
  });

  describe('session expiry', () => {
    it('goes to login when a request answers 401', async () => {
      const request = firstValueFrom(TestBed.inject(HttpClient).get('/api/v1/company/members'));
      http.expectOne('/api/v1/company/members').flush({}, { status: 401, statusText: 'Unauthorized' });

      await expect(request).rejects.toBeInstanceOf(HttpErrorResponse);
      expect(navigation.go).toHaveBeenCalledWith('/api/v1/auth/login');
    });

    it('does nothing on other errors', async () => {
      const request = firstValueFrom(TestBed.inject(HttpClient).get('/api/v1/company/members'));
      http.expectOne('/api/v1/company/members').flush({}, { status: 403, statusText: 'Forbidden' });

      await expect(request).rejects.toBeInstanceOf(HttpErrorResponse);
      expect(navigation.go).not.toHaveBeenCalled();
    });
  });

  describe('errorMessage', () => {
    const response = (status: number, error: unknown) => new HttpErrorResponse({ status, error });

    it('prefers the detail from the API', () => {
      expect(errorMessage(response(409, { title: 'Conflict', detail: 'Already a member.' }))).toBe('Already a member.');
    });

    it('falls back to the title', () => {
      expect(errorMessage(response(500, { title: 'Something went wrong on our side.' }))).toBe(
        'Something went wrong on our side.',
      );
    });

    it('explains a lost connection', () => {
      expect(errorMessage(response(0, null))).toContain("can't reach the server");
    });

    it('never shows raw errors', () => {
      expect(errorMessage(new Error('secret internal detail'))).not.toContain('secret');
    });
  });

  describe('labels', () => {
    it('names roles and permissions', () => {
      expect(roleName('tech-lead')).toBe('Tech Lead');
      expect(roleName(null)).toBe('No role');
      expect(permissionDescription('releases:start')).toBe('Start releases and hotfixes');
      expect(permissionDescription('new:permission')).toBe('new:permission');
    });
  });
});
