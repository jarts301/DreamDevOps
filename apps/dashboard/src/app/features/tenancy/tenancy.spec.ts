import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { BrowserNavigation } from '../../core/browser-navigation';
import { SessionService } from '../../core/session.service';
import { Shell } from '../../shell/shell';
import { APPLICATION_TYPES, COMPANY_A, COMPANY_B, sampleUser, settle } from '../../testing';
import { invitationLink } from '../identity-access/identity-access.api';
import { Applications } from './applications';
import { Companies } from './companies';
import { CompanyDetail } from './company-detail';
import { type Application, type PlatformCompany, POLL_INTERVAL_MS, suggestSlug } from './tenancy.api';

const PLATFORM_ADMIN = sampleUser({
  companyId: null,
  companyName: null,
  role: null,
  permissions: ['audit:read-own', 'companies:manage'],
  memberships: [],
});

const resource = (overrides: Partial<PlatformCompany['resources'][number]> = {}) => ({
  kind: 'git-organization',
  status: 'ready' as const,
  name: 'acme',
  url: 'http://localhost:3000/acme',
  lastError: null,
  attempts: 1,
  updatedAt: '2026-11-04T10:00:00Z',
  ...overrides,
});

const company = (overrides: Partial<PlatformCompany> = {}): PlatformCompany => ({
  id: COMPANY_A,
  slug: 'acme',
  name: 'Acme',
  status: 'active',
  createdAt: '2026-11-04T10:00:00Z',
  statusChangedAt: '2026-11-04T10:00:00Z',
  erasedAt: null,
  memberCount: 0,
  resources: [resource()],
  ...overrides,
});

const application = (overrides: Partial<Application> = {}): Application => ({
  id: 'app-1',
  slug: 'billing-api',
  name: 'Billing API',
  description: 'Bills customers.',
  type: 'typescript-backend',
  scaffold: 'nestjs',
  repository: { status: 'ready', name: 'billing-api', url: 'http://localhost:3000/acme/billing-api', lastError: null },
  status: 'active',
  createdAt: '2026-11-04T10:00:00Z',
  updatedAt: '2026-11-04T10:00:00Z',
  archivedAt: null,
  ...overrides,
});

const PROFILE = {
  id: COMPANY_A,
  slug: 'acme',
  name: 'Acme',
  status: 'active',
  resources: [{ kind: 'git-organization', status: 'ready', name: 'acme', url: 'http://localhost:3000/acme' }],
};

// Longer than a render takes, so a check never happens before a test expects it.
const POLL_MS = 100;
const nextPoll = () => new Promise((resolve) => setTimeout(resolve, POLL_MS + 50));

describe('tenancy screens', () => {
  let http: HttpTestingController;
  const navigation = { go: vi.fn() };

  beforeEach(() => {
    navigation.go.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: BrowserNavigation, useValue: navigation },
        { provide: POLL_INTERVAL_MS, useValue: POLL_MS },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ companyId: COMPANY_A }) } } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const element = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
  const text = (fixture: ComponentFixture<unknown>) => element(fixture).textContent ?? '';
  const button = (fixture: ComponentFixture<unknown>, label: string) =>
    [...element(fixture).querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
    );
  const input = (fixture: ComponentFixture<unknown>, label: string) => {
    const field = [...element(fixture).querySelectorAll('label')].find(
      (candidate) => candidate.querySelector('span')?.textContent?.trim() === label,
    );
    return field?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea') ?? null;
  };
  const type = (field: HTMLInputElement | HTMLTextAreaElement | null, value: string) => {
    field!.value = value;
    field!.dispatchEvent(new Event('input'));
  };
  const render = async (fixture: ComponentFixture<unknown>) => {
    await settle();
    await fixture.whenStable();
  };
  const signedInAs = async (user: object) => {
    const loading = TestBed.inject(SessionService).load();
    http.expectOne('/api/v1/auth/me').flush(user);
    await loading;
  };

  it('suggests slugs the way the API does', () => {
    expect(suggestSlug('  Acme Café -- Société! ')).toBe('acme-cafe-societe');
    expect(suggestSlug('a'.repeat(39) + ' tail')).toBe('a'.repeat(39));
  });

  describe('Companies', () => {
    const open = async (companies: PlatformCompany[] = [company()]) => {
      const fixture = TestBed.createComponent(Companies);
      fixture.detectChanges();
      http.expectOne('/api/v1/platform/companies').flush(companies);
      await render(fixture);
      return fixture;
    };

    it('lists companies with their status, resources and members', async () => {
      const fixture = await open([
        company({ memberCount: 3 }),
        company({
          id: COMPANY_B,
          name: 'Globex',
          slug: 'globex',
          status: 'provisioning',
          resources: [resource({ status: 'failed' })],
        }),
      ]);

      const rows = [...element(fixture).querySelectorAll('tbody tr')].map((row) => row.textContent ?? '');
      expect(rows[0]).toContain('Acme');
      expect(rows[0]).toContain('Active');
      expect(rows[0]).toContain('Git organization: Ready');
      expect(rows[0]).toContain('3');
      expect(rows[1]).toContain('Provisioning');
      expect(rows[1]).toContain('Git organization: Failed');
      const link = element(fixture).querySelector<HTMLAnchorElement>('tbody a');
      expect(link?.getAttribute('href')).toBe(`/platform/companies/${COMPANY_A}`);
    });

    it('says when there are no companies', async () => {
      const fixture = await open([]);

      expect(text(fixture)).toContain('No companies yet.');
    });

    it('suggests a slug from the name until someone types one', async () => {
      const fixture = await open();

      type(input(fixture, 'Company name'), 'Acme Café');
      await render(fixture);
      expect(input(fixture, 'Slug')?.value).toBe('acme-cafe');

      type(input(fixture, 'Slug'), 'acme-eu');
      type(input(fixture, 'Company name'), 'Acme Europe');
      await render(fixture);
      expect(input(fixture, 'Slug')?.value).toBe('acme-eu');
    });

    it('keeps a slug the API would refuse from being sent', async () => {
      const fixture = await open();

      type(input(fixture, 'Company name'), 'Acme');
      type(input(fixture, 'Slug'), 'Not A Slug');
      await render(fixture);

      expect(button(fixture, 'Create company')?.disabled).toBe(true);
    });

    it('creates a company and opens it', async () => {
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const fixture = await open();
      type(input(fixture, 'Company name'), 'Initech');
      await render(fixture);

      button(fixture, 'Create company')!.click();
      const request = http.expectOne('/api/v1/platform/companies');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ name: 'Initech', slug: 'initech' });
      request.flush(company({ id: COMPANY_B, name: 'Initech', slug: 'initech', status: 'provisioning' }));
      await render(fixture);

      expect(navigate).toHaveBeenCalledWith(['/platform/companies', COMPANY_B]);
    });

    it("shows the API's reason for refusing", async () => {
      const fixture = await open();
      type(input(fixture, 'Company name'), 'Acme');
      await render(fixture);

      button(fixture, 'Create company')!.click();
      http
        .expectOne('/api/v1/platform/companies')
        .flush({ detail: 'Another company already uses the slug "acme".' }, { status: 409, statusText: 'Conflict' });
      await render(fixture);

      expect(element(fixture).querySelector('[role="alert"]')?.textContent).toContain('already uses the slug');
    });
  });

  describe('CompanyDetail', () => {
    const path = `/api/v1/platform/companies/${COMPANY_A}`;

    const open = async (shown: PlatformCompany = company()) => {
      const fixture = TestBed.createComponent(CompanyDetail);
      fixture.detectChanges();
      http.expectOne(path).flush(shown);
      await render(fixture);
      return fixture;
    };

    it('shows the company, its status and its resources', async () => {
      const fixture = await open(company({ memberCount: 2 }));

      expect(element(fixture).querySelector('h1')?.textContent).toBe('Acme');
      expect(text(fixture)).toContain('Active');
      expect(text(fixture)).toContain('2 members');
      const link = element(fixture).querySelector<HTMLAnchorElement>('a[href="http://localhost:3000/acme"]');
      expect(link?.textContent).toBe('acme');
      expect(link?.rel).toContain('noopener');
      expect(text(fixture)).toContain('The company has members.');
    });

    it('checks again while provisioning, and stops once the company is active', async () => {
      const fixture = await open(company({ status: 'provisioning', resources: [resource({ status: 'pending', url: null, attempts: 0 })] }));
      expect(text(fixture)).toContain('Setting up the company');
      expect(text(fixture)).toContain('You can invite the first admin once the company is active.');

      await nextPoll();
      http.expectOne(path).flush(company({ status: 'provisioning', resources: [resource({ status: 'pending', url: null })] }));
      await nextPoll();
      http.expectOne(path).flush(company());
      await render(fixture);

      expect(text(fixture)).not.toContain('Setting up the company');
      expect(input(fixture, 'Email of the first admin')).not.toBeNull();
      await nextPoll();
      http.expectNone(path);
    });

    it('stops checking when the page closes', async () => {
      const fixture = await open(company({ status: 'provisioning', resources: [resource({ status: 'pending' })] }));

      fixture.destroy();
      await nextPoll();

      http.expectNone(path);
    });

    it('shows why provisioning failed, and tries again on request', async () => {
      const failed = resource({ status: 'failed', url: null, lastError: 'Git hosting could not be reached.', attempts: 6 });
      const fixture = await open(company({ status: 'provisioning', resources: [failed] }));
      await nextPoll();
      http.expectOne(path).flush(company({ status: 'provisioning', resources: [failed] }));
      await render(fixture);

      expect(text(fixture)).toContain('Git hosting could not be reached.');
      expect(text(fixture)).toContain('6 attempts');
      expect(text(fixture)).toContain("A resource couldn't be provisioned.");
      expect(text(fixture)).not.toContain('Setting up the company');

      button(fixture, 'Retry provisioning')!.click();
      const request = http.expectOne(`${path}/provisioning`);
      expect(request.request.method).toBe('POST');
      request.flush(company());
      await render(fixture);

      expect(button(fixture, 'Retry provisioning')).toBeUndefined();
    });

    it('offers provisioning for a company whose resources never started', async () => {
      const fixture = await open(company({ resources: [resource({ status: 'pending', url: null, attempts: 0 })] }));

      expect(button(fixture, 'Retry provisioning')).toBeDefined();
      fixture.destroy();
    });

    it('invites the first admin of an active company, and shows the link once', async () => {
      const fixture = await open();
      type(input(fixture, 'Email of the first admin'), 'founder@example.com');
      await render(fixture);

      button(fixture, 'Create invitation')!.click();
      const request = http.expectOne(`${path}/first-admin-invitation`);
      expect(request.request.body).toEqual({ email: 'founder@example.com' });
      request.flush({ id: 'inv-1', token: 'secret-token', expiresAt: '2026-11-11T00:00:00Z' });
      await render(fixture);

      const link = element(fixture).querySelector<HTMLInputElement>('[aria-label="Invitation link"]');
      expect(link?.value).toBe(invitationLink('secret-token'));
      expect(input(fixture, 'Email of the first admin')?.value).toBe('');
    });

    it('renames the company only when the name changed', async () => {
      const fixture = await open();
      expect(button(fixture, 'Save name')?.disabled).toBe(true);

      type(input(fixture, 'Company name'), 'Acme Holdings');
      await render(fixture);
      button(fixture, 'Save name')!.click();
      const request = http.expectOne(path);
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({ name: 'Acme Holdings' });
      request.flush(company({ name: 'Acme Holdings' }));
      await render(fixture);

      expect(element(fixture).querySelector('h1')?.textContent).toBe('Acme Holdings');
      expect(button(fixture, 'Save name')?.disabled).toBe(true);
    });

    it('suspends and reactivates', async () => {
      const fixture = await open(company({ memberCount: 1 }));

      button(fixture, 'Suspend company')!.click();
      http.expectOne(`${path}/suspend`).flush(company({ status: 'suspended', memberCount: 1 }));
      await render(fixture);
      expect(text(fixture)).toContain('Suspended');
      expect(button(fixture, 'Suspend company')).toBeUndefined();

      button(fixture, 'Reactivate company')!.click();
      http.expectOne(`${path}/reactivate`).flush(company({ memberCount: 1 }));
      await render(fixture);
      expect(button(fixture, 'Suspend company')).toBeDefined();
    });

    it('asks for confirmation before closing, which is permanent', async () => {
      const fixture = await open();

      button(fixture, 'Close company')!.click();
      await render(fixture);
      http.expectNone(`${path}/close`);
      expect(text(fixture)).toContain('Closing is permanent.');

      button(fixture, 'Confirm close')!.click();
      http.expectOne(`${path}/close`).flush(company({ status: 'closed' }));
      await render(fixture);

      expect(text(fixture)).toContain('This company is closed.');
      expect(button(fixture, 'Close company')).toBeUndefined();
      expect(button(fixture, 'Save name')).toBeUndefined();
      expect(button(fixture, 'Retry provisioning')).toBeUndefined();
    });

    it('erases a closed company only once its slug is typed', async () => {
      const fixture = await open(company({ status: 'closed', memberCount: 1 }));
      expect(text(fixture)).toContain('This can\'t be undone.');
      expect(button(fixture, 'Save name')).toBeUndefined();
      expect(button(fixture, 'Close company')).toBeUndefined();

      type(input(fixture, 'Type the slug acme to confirm'), 'acm');
      await render(fixture);
      expect(button(fixture, 'Erase company data')?.disabled).toBe(true);
      type(input(fixture, 'Type the slug acme to confirm'), 'acme');
      await render(fixture);
      button(fixture, 'Erase company data')!.click();

      const request = http.expectOne(`${path}/erase`);
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ confirmation: 'acme' });
      const erased = company({
        name: 'Erased company 00000000',
        slug: 'erased-000000000000400080000000000000a',
        status: 'erased',
        erasedAt: '2026-11-05T10:00:00Z',
        resources: [resource({ status: 'pending', name: null, url: null, attempts: 0 })],
      });
      request.flush(erased);
      await render(fixture);

      expect(element(fixture).querySelector('h1')?.textContent).toBe('Erased company 00000000');
      expect(text(fixture)).toContain('Erasing the company\'s resources in other tools.');
      expect(text(fixture)).toContain('To be deleted');
      expect(button(fixture, 'Erase company data')).toBeUndefined();
      expect(button(fixture, 'Retry erasure')).toBeUndefined();

      await nextPoll();
      http.expectOne(path).flush({ ...erased, resources: [resource({ status: 'erased', name: null, url: null })] });
      await render(fixture);
      expect(text(fixture)).toContain('Deleted');
      expect(text(fixture)).toContain("This company's data was erased on");
      expect(text(fixture)).not.toContain('First admin');
    });

    it('offers to retry an erasure that a resource blocked', async () => {
      const blocked = resource({
        status: 'failed',
        name: null,
        url: null,
        lastError: 'The Git organization still has repositories. Delete or move them in Git hosting, then retry.',
      });
      const fixture = await open(company({ status: 'erased', erasedAt: '2026-11-05T10:00:00Z', resources: [blocked] }));

      expect(text(fixture)).toContain("A resource couldn't be erased yet.");
      expect(text(fixture)).toContain('still has repositories');
      button(fixture, 'Retry erasure')!.click();
      http.expectOne(`${path}/provisioning`).flush(company({ status: 'erased', resources: [resource({ status: 'erased' })] }));
      await render(fixture);
    });

    it('keeps the company on screen when an action is refused', async () => {
      const fixture = await open();

      button(fixture, 'Suspend company')!.click();
      http
        .expectOne(`${path}/suspend`)
        .flush({ detail: 'Only an active company can be suspended.' }, { status: 409, statusText: 'Conflict' });
      await render(fixture);

      expect(element(fixture).querySelector('[role="alert"]')?.textContent).toContain('Only an active company');
      expect(element(fixture).querySelector('h1')?.textContent).toBe('Acme');
    });
  });

  describe('Applications', () => {
    const open = async (user: object, applications: Application[] = [application()]) => {
      await signedInAs(user);
      const fixture = TestBed.createComponent(Applications);
      fixture.detectChanges();
      http.expectOne('/api/v1/company').flush(PROFILE);
      http.expectOne('/api/v1/company/applications').flush(applications);
      http.expectOne('/api/v1/application-types').flush(APPLICATION_TYPES);
      await render(fixture);
      return fixture;
    };
    const radio = (fixture: ComponentFixture<unknown>, typeName: string) =>
      [...element(fixture).querySelectorAll<HTMLLabelElement>('.type-option')]
        .find((option) => option.querySelector('.type-option-name')?.textContent === typeName)!
        .querySelector<HTMLInputElement>('input[type="radio"]')!;
    const MANAGER = sampleUser({
      permissions: [
        'applications:archive',
        'applications:create',
        'applications:update',
        'applications:view',
        'dashboards:view',
      ],
    });
    const VIEWER = sampleUser({ role: 'viewer', permissions: ['applications:view', 'dashboards:view'] });

    it("lists the company's applications and links its Git organization", async () => {
      const fixture = await open(VIEWER, [
        application(),
        application({ id: 'app-2', name: 'Old Site', slug: 'old-site', status: 'archived', archivedAt: '2026-11-05T00:00:00Z' }),
      ]);

      expect(text(fixture)).toContain('The software Acme builds and runs.');
      expect(element(fixture).querySelector('a[href="http://localhost:3000/acme"]')).not.toBeNull();
      const [active, archived] = [...element(fixture).querySelectorAll('section')].slice(-2);
      expect(active?.textContent).toContain('Billing API');
      expect(active?.textContent).not.toContain('Old Site');
      expect(archived?.textContent).toContain('Old Site');
    });

    it('shows viewers no way to change applications', async () => {
      const fixture = await open(VIEWER);

      expect(input(fixture, 'Application name')).toBeNull();
      expect(button(fixture, 'Archive Billing API')).toBeUndefined();
      expect(button(fixture, 'Edit Billing API')).toBeUndefined();
    });

    it('shows each action only to people with its permission', async () => {
      const archived = application({ id: 'app-2', name: 'Old Site', status: 'archived', archivedAt: '2026-11-05T00:00:00Z' });
      const editor = await open(sampleUser({ permissions: ['applications:update', 'applications:view'] }), [
        application(),
        archived,
      ]);

      expect(input(editor, 'Application name')).toBeNull();
      expect(button(editor, 'Edit Billing API')).toBeDefined();
      expect(button(editor, 'Archive Billing API')).toBeUndefined();
      expect(button(editor, 'Restore Old Site')).toBeUndefined();
    });

    it('lets someone who may only archive do just that', async () => {
      const archived = application({ id: 'app-2', name: 'Old Site', status: 'archived', archivedAt: '2026-11-05T00:00:00Z' });
      const archiver = await open(sampleUser({ permissions: ['applications:archive', 'applications:view'] }), [
        application(),
        archived,
      ]);

      expect(input(archiver, 'Application name')).toBeNull();
      expect(button(archiver, 'Edit Billing API')).toBeUndefined();
      expect(button(archiver, 'Archive Billing API')).toBeDefined();
      expect(button(archiver, 'Restore Old Site')).toBeDefined();
    });

    it('says who can create the first application', async () => {
      const fixture = await open(VIEWER, []);

      expect(text(fixture)).toContain('A Company Admin or Tech Lead can create one.');
    });

    it('registers an application as the chosen type, with a suggested slug', async () => {
      const fixture = await open(MANAGER, []);
      type(input(fixture, 'Application name'), 'Web Shop');
      type(input(fixture, 'Description (optional)'), 'Sells things.');
      await render(fixture);
      expect(input(fixture, 'Slug')?.value).toBe('web-shop');
      expect(button(fixture, 'Create application')?.disabled).toBe(true);

      radio(fixture, 'TypeScript frontend').click();
      await render(fixture);
      expect(radio(fixture, 'Angular').checked).toBe(true);
      radio(fixture, 'React').click();
      await render(fixture);
      button(fixture, 'Create application')!.click();
      const request = http.expectOne('/api/v1/company/applications');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        type: 'typescript-frontend',
        scaffold: 'react',
        name: 'Web Shop',
        slug: 'web-shop',
        description: 'Sells things.',
      });
      request.flush(application({ name: 'Web Shop', slug: 'web-shop' }));
      await settle();
      http.expectOne('/api/v1/company/applications').flush([application({ name: 'Web Shop', slug: 'web-shop' })]);
      await render(fixture);

      expect(text(fixture)).toContain('Web Shop');
      expect(input(fixture, 'Application name')?.value).toBe('');
      expect(radio(fixture, 'TypeScript frontend').checked).toBe(false);
    });

    it('offers every type in the catalog, grouped by layer', async () => {
      const fixture = await open(MANAGER, []);

      const groups = [...element(fixture).querySelectorAll('.type-group')].map((group) => ({
        layer: group.getAttribute('aria-label'),
        types: [...group.querySelectorAll('.type-option-name')].map((name) => name.textContent),
      }));
      expect(groups).toEqual([
        { layer: 'Frontend', types: ['Python frontend', 'TypeScript frontend'] },
        { layer: 'Backend', types: ['Python backend', 'TypeScript backend'] },
      ]);
      expect(text(fixture)).toContain('Node.js 24 · Angular, React, Vue, Svelte');
    });

    it("offers each type's own scaffolds, and an empty repository", async () => {
      const fixture = await open(MANAGER, []);
      expect(element(fixture).textContent).not.toContain('Start from');

      radio(fixture, 'Python backend').click();
      await render(fixture);
      const options = [...element(fixture).querySelectorAll('fieldset')[1]!.querySelectorAll('.type-option-name')].map(
        (name) => name.textContent,
      );
      expect(options).toEqual(['FastAPI', 'Empty repository']);
      expect(radio(fixture, 'FastAPI').checked).toBe(true);
      expect(text(fixture)).toContain('Includes: Tests · Linting');

      radio(fixture, 'Empty repository').click();
      type(input(fixture, 'Application name'), 'Imported');
      await render(fixture);
      button(fixture, 'Create application')!.click();
      const request = http.expectOne('/api/v1/company/applications');
      expect(request.request.body).toMatchObject({ type: 'python-backend', scaffold: null });
      request.flush(application({ name: 'Imported', scaffold: null }));
      await settle();
      http.expectOne('/api/v1/company/applications').flush([application({ name: 'Imported', scaffold: null })]);
      await render(fixture);
    });

    it('links a ready repository, and checks again while one is being made', async () => {
      const pending = application({
        id: 'app-2',
        name: 'New Site',
        slug: 'new-site',
        repository: { status: 'pending', name: null, url: null, lastError: null },
      });
      const fixture = await open(VIEWER, [application(), pending]);

      const rows = [...element(fixture).querySelectorAll('tbody tr')];
      expect(rows[0]!.querySelector<HTMLAnchorElement>('a[href="http://localhost:3000/acme/billing-api"]')?.textContent).toBe(
        'billing-api',
      );
      expect(rows[0]!.textContent).toContain('TypeScript backend · NestJS');
      expect(rows[1]!.textContent).toContain('Setting up');

      await nextPoll();
      http
        .expectOne('/api/v1/company/applications')
        .flush([application(), { ...pending, repository: { status: 'ready', name: 'new-site', url: 'http://git/new-site', lastError: null } }]);
      await render(fixture);
      expect(element(fixture).querySelector('a[href="http://git/new-site"]')).not.toBeNull();
      await nextPoll();
      http.expectNone('/api/v1/company/applications');
    });

    const failed = () =>
      application({ repository: { status: 'failed', name: null, url: null, lastError: 'Git hosting could not be reached.' } });

    it("shows a viewer why a repository failed, but no way to retry it", async () => {
      const viewer = await open(VIEWER, [failed()]);

      expect(text(viewer)).toContain('Git hosting could not be reached.');
      expect(button(viewer, 'Retry the repository of Billing API')).toBeUndefined();
    });

    it('retries a failed repository for those who may create applications', async () => {
      const fixture = await open(MANAGER, [failed()]);
      button(fixture, 'Retry the repository of Billing API')!.click();
      const request = http.expectOne('/api/v1/company/applications/app-1/repository');
      expect(request.request.method).toBe('POST');
      request.flush(application({ repository: { status: 'pending', name: null, url: null, lastError: null } }));
      await settle();
      http.expectOne('/api/v1/company/applications').flush([application()]);
      await render(fixture);
      expect(button(fixture, 'Retry the repository of Billing API')).toBeUndefined();
    });

    it("shows each application's type", async () => {
      const fixture = await open(VIEWER, [
        application(),
        application({ id: 'app-2', name: 'Old Tool', slug: 'old-tool', type: null }),
        application({ id: 'app-3', name: 'Retired', slug: 'retired', type: 'cobol-mainframe' }),
      ]);

      const rows = [...element(fixture).querySelectorAll('tbody tr')].map((row) => row.textContent ?? '');
      expect(rows[0]).toContain('TypeScript backend');
      expect(rows[1]).toContain('Not set');
      expect(rows[2]).toContain('cobol-mainframe');
      const link = element(fixture).querySelector<HTMLAnchorElement>('a[href="/applications/types"]');
      expect(link?.textContent).toContain('See what each application type needs');
    });

    it('edits the name and description', async () => {
      const fixture = await open(MANAGER);

      button(fixture, 'Edit Billing API')!.click();
      await render(fixture);
      expect(input(fixture, 'Name')?.value).toBe('Billing API');
      type(input(fixture, 'Name'), 'Billing Service');
      await render(fixture);
      button(fixture, 'Save changes')!.click();
      const request = http.expectOne('/api/v1/company/applications/app-1');
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({ name: 'Billing Service', description: 'Bills customers.' });
      request.flush(application({ name: 'Billing Service' }));
      await settle();
      http.expectOne('/api/v1/company/applications').flush([application({ name: 'Billing Service' })]);
      await render(fixture);

      expect(button(fixture, 'Save changes')).toBeUndefined();
      expect(text(fixture)).toContain('Billing Service');
    });

    it('archives and restores', async () => {
      const fixture = await open(MANAGER);
      const archived = application({ status: 'archived', archivedAt: '2026-11-05T00:00:00Z' });

      button(fixture, 'Archive Billing API')!.click();
      http.expectOne('/api/v1/company/applications/app-1/archive').flush(archived);
      await settle();
      http.expectOne('/api/v1/company/applications').flush([archived]);
      await render(fixture);
      expect(text(fixture)).toContain('Archived applications');

      button(fixture, 'Restore Billing API')!.click();
      http.expectOne('/api/v1/company/applications/app-1/restore').flush(application());
      await settle();
      http.expectOne('/api/v1/company/applications').flush([application()]);
      await render(fixture);
      expect(text(fixture)).not.toContain('Archived applications');
    });

    it("shows the API's reason for refusing", async () => {
      const fixture = await open(MANAGER);
      type(input(fixture, 'Application name'), 'Billing API');
      radio(fixture, 'TypeScript backend').click();
      await render(fixture);

      button(fixture, 'Create application')!.click();
      http
        .expectOne('/api/v1/company/applications')
        .flush(
          { detail: 'Another application in this company already uses the slug "billing-api".' },
          { status: 409, statusText: 'Conflict' },
        );
      await render(fixture);

      expect(element(fixture).querySelector('[role="alert"]')?.textContent).toContain('already uses the slug');
    });
  });

  describe('Shell', () => {
    const links = (fixture: ComponentFixture<unknown>) =>
      [...element(fixture).querySelectorAll('nav a')].map((link) => link.textContent?.trim());

    it("shows a member the company's name and its applications", async () => {
      await signedInAs(sampleUser({ permissions: ['applications:view', 'company-users:manage', 'dashboards:view'] }));
      const fixture = TestBed.createComponent(Shell);
      await render(fixture);

      expect(links(fixture)).toEqual(['Overview', 'Applications', 'Team']);
      expect(text(fixture)).toContain('Acme · Company Admin');
    });

    it('names each company in the switcher', async () => {
      await signedInAs(
        sampleUser({
          memberships: [
            { companyId: COMPANY_A, companyName: 'Acme', role: 'company-admin' },
            { companyId: COMPANY_B, companyName: 'Globex', role: 'viewer' },
          ],
        }),
      );
      const fixture = TestBed.createComponent(Shell);
      await render(fixture);

      const options = [...element(fixture).querySelectorAll('option')].map((option) => option.textContent?.trim());
      expect(options).toEqual(['Acme (Company Admin)', 'Globex (Viewer)']);
    });

    it('shows a Platform Admin the companies, and no company data', async () => {
      await signedInAs(PLATFORM_ADMIN);
      const fixture = TestBed.createComponent(Shell);
      await render(fixture);

      expect(links(fixture)).toEqual(['Overview', 'Companies']);
    });

    it('hides applications from a member without permission to see them', async () => {
      await signedInAs(sampleUser({ permissions: ['dashboards:view'] }));
      const fixture = TestBed.createComponent(Shell);
      await render(fixture);

      expect(links(fixture)).toEqual(['Overview']);
    });
  });
});
