import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describeEvent } from '../../core/events';
import { SessionService } from '../../core/session.service';
import { settle } from '../../testing';
import { Applications } from './applications';

const TYPES = [
  { key: 'restful-service', name: 'RESTful Service', description: 'An HTTP API' },
  { key: 'web-frontend', name: 'Web Frontend', description: 'Runs in the browser' },
];

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
  const answerList = async (applications: object[], status = 'active') => {
    await settle();
    const request = http.expectOne((candidate) => candidate.url === '/api/v1/company/applications');
    expect(request.request.params.get('status')).toBe(status);
    request.flush(applications);
  };
  const open = async (applications: object[] = [BILLING], options: { manager?: boolean } = { manager: true }) => {
    setUp(options.manager ? ['applications:create'] : ['dashboards:view']);
    const fixture = TestBed.createComponent(Applications);
    fixture.detectChanges();
    await settle();
    if (options.manager) {
      http.expectOne('/api/v1/company/application-types').flush(TYPES);
    }
    await answerList(applications);
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
    expect(text(fixture)).toContain('Not created yet');
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
    await answerList([LEGACY], 'archived');
    await render(fixture);
    expect(text(fixture)).toContain('Archived applications');
    expect(button(fixture, 'Archived').getAttribute('aria-pressed')).toBe('true');

    button(fixture, 'Restore Legacy').click();
    http.expectOne('/api/v1/company/applications/a-2/restore').flush(null);
    await answerList([], 'archived');
    await render(fixture);

    expect(text(fixture)).toContain('Legacy is restored.');
  });
});
