import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describeEvent } from '../../core/events';
import { SessionService } from '../../core/session.service';
import { settle } from '../../testing';
import { Applications } from './applications';

const blueprint = (key: string, name: string, framework: string) => ({
  key,
  version: '1.0.0',
  name,
  language: 'TypeScript',
  framework,
});
const TYPES = [
  {
    key: 'restful-service',
    name: 'RESTful Service',
    description: 'An HTTP API',
    blueprint: blueprint('node-service', 'Node.js service', 'Fastify'),
  },
  {
    key: 'web-frontend',
    name: 'Web Frontend',
    description: 'Runs in the browser',
    blueprint: blueprint('angular-frontend', 'Angular frontend', 'Angular 22'),
  },
];
const ACCESS = {
  signInUrl: 'http://git.test/user/oauth2/keycloak',
  gitUrl: 'http://git.test',
  hasAccount: true,
  team: 'tech-leads',
};
const READY = {
  applicationId: 'a-1',
  status: 'ready',
  fullName: 'acme/billing',
  url: 'http://git.test/acme/billing',
  blueprint: { key: 'node-service', version: '1.0.0' },
  lastError: null,
};

const BILLING = {
  id: 'a-1',
  name: 'Billing',
  slug: 'billing',
  type: { key: 'restful-service', name: 'RESTful Service' },
  description: 'Charges customers',
  status: 'active',
  createdAt: '2026-11-01T10:00:00Z',
  createdBy: { userId: 'u-1', displayName: 'Ana Admin' },
  archivedAt: null,
};
const LEGACY = { ...BILLING, id: 'a-2', name: 'Legacy', slug: 'legacy', status: 'archived', archivedAt: '2026-11-02T10:00:00Z' };

describe('Applications', () => {
  let http: HttpTestingController;

  const setUp = (permissions: string[]) => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: SessionService,
          useValue: { user: () => ({ permissions }), can: (permission: string) => permissions.includes(permission) },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  };

  afterEach(() => http.verify());

  const element = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
  const text = (fixture: ComponentFixture<unknown>) => element(fixture).textContent ?? '';
  const button = (fixture: ComponentFixture<unknown>, label: string) =>
    [...element(fixture).querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
    )!;
  const render = async (fixture: ComponentFixture<unknown>) => {
    await settle();
    await fixture.whenStable();
  };
  const answerList = async (applications: object[], status = 'active', repositories: object[] = [READY]) => {
    await settle();
    const request = http.expectOne((candidate) => candidate.url === '/api/v1/company/applications');
    expect(request.request.params.get('status')).toBe(status);
    request.flush(applications);
    http.expectOne('/api/v1/company/repositories').flush(repositories);
  };
  const open = async (
    applications: object[] = [BILLING],
    options: { manager?: boolean; repositories?: object[]; access?: object } = { manager: true },
  ) => {
    setUp(options.manager ? ['applications:create'] : ['dashboards:view']);
    const fixture = TestBed.createComponent(Applications);
    fixture.detectChanges();
    await settle();
    if (options.manager) {
      http.expectOne('/api/v1/company/application-types').flush(TYPES);
    }
    await answerList(applications, 'active', options.repositories ?? [READY]);
    await settle();
    http.expectOne('/api/v1/company/source-access').flush(options.access ?? ACCESS);
    await render(fixture);
    return fixture;
  };
  const type = async (fixture: ComponentFixture<unknown>, selector: string, value: string) => {
    const input = element(fixture).querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await render(fixture);
  };

  it('describes application changes in the audit log', () => {
    setUp([]);
    expect(describeEvent('ApplicationRegistered', { name: 'Billing' })).toBe('Registered the application "Billing"');
    expect(describeEvent('ApplicationUpdated', { name: 'Payments', previousName: 'Billing' })).toBe(
      'Renamed the application "Billing" to "Payments"',
    );
    expect(describeEvent('ApplicationUpdated', { descriptionChanged: true })).toBe(
      "Changed an application's description",
    );
    expect(describeEvent('ApplicationArchived', { name: 'Billing' })).toBe('Archived the application "Billing"');
  });

  it('lists applications with their type, short name and who registered them', async () => {
    const fixture = await open();

    expect(text(fixture)).toContain('Billing');
    expect(text(fixture)).toContain('Charges customers');
    expect(text(fixture)).toContain('RESTful Service');
    expect(text(fixture)).toContain('by Ana Admin');
    const link = element(fixture).querySelector<HTMLAnchorElement>('a[href="http://git.test/acme/billing"]')!;
    expect(link.textContent).toBe('acme/billing');
    expect(link.rel).toBe('noopener');
    expect(text(fixture)).toContain('From node-service 1.0.0');
    const builds = element(fixture).querySelector<HTMLAnchorElement>('a[aria-label="Builds of Billing"]')!;
    expect(builds.getAttribute('href')).toBe('/builds?application=a-1');
  });

  it('shows members without the permission the list only', async () => {
    const fixture = await open([BILLING], { manager: false });

    expect(text(fixture)).not.toContain('Register an application');
    expect(button(fixture, 'Edit Billing')).toBeUndefined();
    expect(button(fixture, 'Archive Billing')).toBeUndefined();
  });

  it('registers an application of the chosen type', async () => {
    const fixture = await open([]);
    expect(text(fixture)).toContain('RESTful Service: An HTTP API');
    expect(text(fixture)).toContain('It starts from the Node.js service blueprint 1.0.0, in TypeScript with Fastify.');

    await type(fixture, 'input[formcontrolname="name"]', 'Storefront');
    const select = element(fixture).querySelector<HTMLSelectElement>('select[formcontrolname="type"]')!;
    select.value = 'web-frontend';
    select.dispatchEvent(new Event('change'));
    await type(fixture, 'textarea[formcontrolname="description"]', 'The shop');
    expect(text(fixture)).toContain('Web Frontend: Runs in the browser');

    button(fixture, 'Register application').click();
    const request = http.expectOne((candidate) => candidate.method === 'POST');
    expect(request.request.body).toEqual({ name: 'Storefront', type: 'web-frontend', description: 'The shop' });
    request.flush({ ...BILLING, id: 'a-3', name: 'Storefront' });
    await answerList([BILLING]);
    await render(fixture);

    expect(text(fixture)).toContain('Storefront is registered.');
  });

  it('shows why a registration was refused', async () => {
    const fixture = await open();
    await type(fixture, 'input[formcontrolname="name"]', 'billing');

    button(fixture, 'Register application').click();
    http
      .expectOne((candidate) => candidate.method === 'POST')
      .flush({ status: 409, detail: 'Another application already has this name.' }, { status: 409, statusText: 'Conflict' });
    await render(fixture);

    expect(text(fixture)).toContain('Another application already has this name.');
  });

  it('edits the name and description', async () => {
    const fixture = await open();

    button(fixture, 'Edit Billing').click();
    await render(fixture);
    expect(text(fixture)).toContain('The short name stays the same.');
    const editName = element(fixture).querySelectorAll<HTMLInputElement>('input[formcontrolname="name"]')[1]!;
    editName.value = 'Payments';
    editName.dispatchEvent(new Event('input'));
    await render(fixture);
    button(fixture, 'Save').click();

    const request = http.expectOne('/api/v1/company/applications/a-1');
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ name: 'Payments', description: 'Charges customers' });
    request.flush(null);
    await answerList([{ ...BILLING, name: 'Payments' }]);
    await render(fixture);

    expect(text(fixture)).toContain('Payments');
  });

  it('asks for confirmation before archiving', async () => {
    const fixture = await open();

    button(fixture, 'Archive Billing').click();
    await render(fixture);
    http.expectNone((candidate) => candidate.method === 'POST');
    button(fixture, 'Confirm archiving').click();
    http.expectOne('/api/v1/company/applications/a-1/archive').flush(null);
    await answerList([]);
    await render(fixture);

    expect(text(fixture)).toContain('Billing is archived.');
    expect(text(fixture)).toContain('No applications yet.');
  });

  it('shows archived applications on request, and restores them', async () => {
    const fixture = await open();

    button(fixture, 'Archived').click();
    await answerList([LEGACY], 'archived', []);
    await render(fixture);
    expect(text(fixture)).toContain('Archived applications');
    expect(button(fixture, 'Archived').getAttribute('aria-pressed')).toBe('true');

    button(fixture, 'Restore Legacy').click();
    http.expectOne('/api/v1/company/applications/a-2/restore').flush(null);
    await answerList([], 'archived', []);
    await render(fixture);

    expect(text(fixture)).toContain('Legacy is restored.');
  });
  it('keeps refreshing while a repository is being created', async () => {
    setUp(['dashboards:view']);
    vi.useFakeTimers();
    try {
      const fixture = TestBed.createComponent(Applications);
      fixture.detectChanges();
      await vi.advanceTimersByTimeAsync(0);
      http.expectOne((candidate) => candidate.url === '/api/v1/company/applications').flush([BILLING]);
      http.expectOne('/api/v1/company/repositories').flush([{ ...READY, status: 'creating', blueprint: null }]);
      await vi.advanceTimersByTimeAsync(0);
      http.expectOne('/api/v1/company/source-access').flush(ACCESS);
      await vi.advanceTimersByTimeAsync(0);
      expect(text(fixture)).toContain('Being created…');

      await vi.advanceTimersByTimeAsync(3_000);
      http.expectOne((candidate) => candidate.url === '/api/v1/company/applications').flush([BILLING]);
      http.expectOne('/api/v1/company/repositories').flush([READY]);
      await vi.advanceTimersByTimeAsync(10_000);

      http.expectNone('/api/v1/company/repositories');
      expect(text(fixture)).toContain('acme/billing');
      fixture.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a just-registered application as being created until its repository appears', async () => {
    setUp(['dashboards:view']);
    vi.useFakeTimers();
    try {
      const fresh = { ...BILLING, createdAt: new Date().toISOString() };
      const fixture = TestBed.createComponent(Applications);
      fixture.detectChanges();
      await vi.advanceTimersByTimeAsync(0);
      http.expectOne((candidate) => candidate.url === '/api/v1/company/applications').flush([fresh]);
      http.expectOne('/api/v1/company/repositories').flush([]);
      await vi.advanceTimersByTimeAsync(0);
      http.expectOne('/api/v1/company/source-access').flush(ACCESS);
      await vi.advanceTimersByTimeAsync(0);
      expect(text(fixture)).toContain('Being created…');
      expect(text(fixture)).not.toContain('Not created');

      await vi.advanceTimersByTimeAsync(3_000);
      http.expectOne((candidate) => candidate.url === '/api/v1/company/applications').flush([fresh]);
      http.expectOne('/api/v1/company/repositories').flush([READY]);
      await vi.advanceTimersByTimeAsync(10_000);

      http.expectNone('/api/v1/company/repositories');
      expect(text(fixture)).toContain('acme/billing');
      fixture.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('explains a failed repository and tries again on request', async () => {
    const fixture = await open([BILLING], {
      manager: true,
      repositories: [{ ...READY, status: 'failed', lastError: 'The Git service could not be reached.' }],
    });
    expect(text(fixture)).toContain('Failed');
    expect(text(fixture)).toContain('The Git service could not be reached.');

    button(fixture, 'Try creating the repository of Billing again').click();
    const request = http.expectOne('/api/v1/company/applications/a-1/repository');
    expect(request.request.method).toBe('POST');
    request.flush(null);
    await answerList([BILLING], 'active', [READY]);
    await render(fixture);

    expect(text(fixture)).toContain('The repository of Billing is being created.');
  });

  it('offers to create a repository for an application registered before repositories existed', async () => {
    const fixture = await open([BILLING], { manager: true, repositories: [] });

    expect(text(fixture)).toContain('Not created');
    button(fixture, 'Create the repository of Billing').click();
    http.expectOne('/api/v1/company/applications/a-1/repository').flush(null);
    await answerList([BILLING], 'active', [READY]);
    await render(fixture);

    expect(text(fixture)).toContain('acme/billing');
  });

  it('shows members their Git team', async () => {
    const fixture = await open([BILLING], { manager: false });

    expect(text(fixture)).toContain(
      "You're in the Tech Leads team in Forgejo, so you can push code and approve pull requests.",
    );
    expect(button(fixture, 'Create the repository of Billing')).toBeUndefined();
  });

  it('asks members without a Git account to sign in to Forgejo, then checks again', async () => {
    const fixture = await open([BILLING], {
      manager: false,
      access: { ...ACCESS, hasAccount: false, team: 'developers' },
    });
    const signIn = [...element(fixture).querySelectorAll('a')].find(
      (link) => link.textContent?.trim() === 'Sign in to Forgejo',
    )!;
    expect(signIn.href).toBe('http://git.test/user/oauth2/keycloak');

    button(fixture, 'Check again').click();
    const request = http.expectOne('/api/v1/company/source-access/sync');
    expect(request.request.method).toBe('POST');
    request.flush({ ...ACCESS, team: 'developers' });
    await render(fixture);

    expect(text(fixture)).toContain("You're in the Developers team now.");
    expect(text(fixture)).toContain('push code and open pull requests');
  });
});
