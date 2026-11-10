import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SessionService } from '../../core/session.service';
import { settle } from '../../testing';
import { EnvironmentDetail } from './environment-detail';

const environment = (kind: 'test' | 'production') => ({
  id: 'e-1',
  name: kind === 'production' ? 'Live' : 'Staging',
  slug: 'env',
  kind,
  acceptsFeatureImages: kind === 'test',
  acceptedImages: kind === 'test' ? ['feature', 'rc', 'final'] : ['final'],
  requiresApproval: false,
  status: 'active',
  createdAt: '2026-11-01T10:00:00Z',
  archivedAt: null,
  target: { id: 't-1', status: 'connected' },
});
const APPLICATIONS = [{ id: 'a-1', name: 'Billing' }];
const CONFIG = {
  variables: [{ name: 'LOG_LEVEL', value: 'info', scope: 'environment', updatedAt: '2026-11-10T10:00:00Z' }],
  secrets: [{ name: 'DATABASE_URL', scope: 'environment', updatedAt: '2026-11-10T10:00:00Z' }],
};

describe('EnvironmentDetail', () => {
  let http: HttpTestingController;

  const open = async (kind: 'test' | 'production', permissions: string[]) => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: SessionService,
          useValue: { user: () => ({ userId: 'u-1', permissions }), can: (permission: string) => permissions.includes(permission) },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(EnvironmentDetail);
    fixture.componentRef.setInput('id', 'e-1');
    fixture.detectChanges();
    await settle();
    http.expectOne('/api/v1/company/environments/e-1').flush(environment(kind));
    http.expectOne((request) => request.url === '/api/v1/company/applications').flush(APPLICATIONS);
    await settle();
    http.expectOne((request) => request.url === '/api/v1/company/environments/e-1/config').flush(CONFIG);
    await settle();
    http.expectOne((request) => request.url === '/api/v1/company/deployments').flush([]);
    await settle();
    await fixture.whenStable();
    return fixture;
  };

  afterEach(() => http.verify());

  const element = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
  const text = (fixture: ComponentFixture<unknown>) => element(fixture).textContent?.replace(/\s+/g, ' ') ?? '';
  const type = async (fixture: ComponentFixture<unknown>, form: number, values: string[]) => {
    const inputs = [...element(fixture).querySelectorAll<HTMLInputElement>('form')[form]!.querySelectorAll('input')];
    values.forEach((value, index) => {
      inputs[index]!.value = value;
      inputs[index]!.dispatchEvent(new Event('input'));
    });
    await settle();
    await fixture.whenStable();
  };

  it('shows variables with their values and secrets by name only', async () => {
    const fixture = await open('test', ['dashboards:view']);

    expect(text(fixture)).toContain('LOG_LEVEL');
    expect(text(fixture)).toContain('info');
    expect(text(fixture)).toContain('DATABASE_URL');
    expect(element(fixture).querySelectorAll('form')).toHaveLength(0);
    expect(text(fixture)).toContain('Tech Leads, Operators and Company Admins manage these.');
  });

  it('lets a Company Admin manage a test environment, but not production', async () => {
    const test = await open('test', ['test-environment-config:manage']);
    expect(element(test).querySelectorAll('form')).toHaveLength(2);
    test.destroy();
    TestBed.resetTestingModule();

    const production = await open('production', ['test-environment-config:manage', 'targets:connect']);
    expect(element(production).querySelectorAll('form')).toHaveLength(0);
    expect(text(production)).toContain('Tech Leads and Operators manage these.');
    expect(text(production)).toContain('A second person approves each deployment');
  });

  it('saves a secret for one application, with its value hidden as it is typed', async () => {
    const fixture = await open('production', ['environment-config:manage']);
    const scope = element(fixture).querySelector<HTMLSelectElement>('select')!;
    scope.value = 'a-1';
    scope.dispatchEvent(new Event('change'));
    await settle();
    http.expectOne((request) => request.url === '/api/v1/company/environments/e-1/config' && request.params.get('application') === 'a-1').flush({
      variables: [],
      secrets: [],
    });
    await settle();
    await fixture.whenStable();
    expect(element(fixture).querySelectorAll('form')[1]!.querySelectorAll('input')[1]!.type).toBe('password');

    await type(fixture, 1, ['API_KEY', 'fake-dummy-value']);
    element(fixture).querySelectorAll('form')[1]!.querySelector<HTMLButtonElement>('button')!.click();
    await settle();
    const request = http.expectOne('/api/v1/company/environments/e-1/secrets/API_KEY');
    expect(request.request.body).toEqual({ value: 'fake-dummy-value', application: 'a-1' });
    request.flush(null);
    await settle();
    http.expectOne((candidate) => candidate.url === '/api/v1/company/environments/e-1/config').flush({ variables: [], secrets: [] });
    await settle();
    await fixture.whenStable();
    expect(text(fixture)).toContain('API_KEY is saved. It applies at the next deployment.');
  });
});
