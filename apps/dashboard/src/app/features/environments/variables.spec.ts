import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { describeEvent } from '../../core/events';
import { SessionService } from '../../core/session.service';
import { settle } from '../../testing';
import { EnvironmentVariables } from './environment-variables';
import type { Environment, HostingTarget, Variable } from './environments.api';
import { Environments } from './environments';

const LOCAL_PROVIDER = { key: 'local', name: 'This machine', kind: 'self-hosted' as const, deploys: true };
const LOCAL: HostingTarget = {
  id: 't-local',
  name: 'This machine',
  provider: LOCAL_PROVIDER,
  settings: {},
  status: 'active',
  version: 1,
  environments: 1,
  running: 1,
  servesProduction: false,
  createdAt: '2026-11-01T10:00:00Z',
  archivedAt: null,
};

const environment = (overrides: Partial<Environment> = {}): Environment => ({
  id: 'e-1',
  applicationId: 'a-1',
  name: 'Staging',
  slug: 'staging',
  production: false,
  status: 'active',
  version: 3,
  target: { id: LOCAL.id, name: LOCAL.name, provider: LOCAL_PROVIDER },
  live: {
    deploymentId: 'd-1',
    buildId: 'b-1.5.0',
    version: '1.5.0',
    imageKind: 'release',
    productive: true,
    address: 'http://localhost:49153',
    target: { id: LOCAL.id, name: LOCAL.name },
    since: '2026-11-02T10:00:00Z',
  },
  deploying: null,
  variables: 2,
  settingsPending: false,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  archivedAt: null,
  ...overrides,
});
const PRODUCTION = environment({ id: 'e-2', name: 'Production', slug: 'production', production: true });

const variable = (overrides: Partial<Variable> = {}): Variable => ({
  id: 'v-1',
  environmentId: 'e-1',
  name: 'LOG_LEVEL',
  secret: false,
  value: 'debug',
  version: 1,
  updatedAt: '2026-11-02T10:00:00Z',
  updatedBy: { userId: 'u-1', displayName: 'Taylor Lead' },
  ...overrides,
});
const SECRET = variable({ id: 'v-2', name: 'DATABASE_URL', secret: true, value: null, version: 4 });
const REASON = 'Pointing production at the new database.';

describe('variables and secrets', () => {
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
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) } } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  };

  afterEach(() => http.verify());

  const element = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
  const text = (fixture: ComponentFixture<unknown>) => (element(fixture).textContent ?? '').replace(/\s+/g, ' ');
  const button = (fixture: ComponentFixture<unknown>, label: string) =>
    [...element(fixture).querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
    );
  const render = async (fixture: ComponentFixture<unknown>) => {
    await settle();
    await fixture.whenStable();
  };
  const type = async (fixture: ComponentFixture<unknown>, field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    field.value = value;
    field.dispatchEvent(new Event('input'));
    await render(fixture);
  };
  const fieldLabelled = (fixture: ComponentFixture<unknown>, label: string) =>
    [...element(fixture).querySelectorAll('label')]
      .find((candidate) => candidate.querySelector('span')?.textContent?.trim() === label)!
      .querySelector<HTMLInputElement>('input, textarea, select')!;

  describe('the panel', () => {
    const open = async (
      options: { environment?: Environment; canManage?: boolean; canDeploy?: boolean; variables?: Variable[] } = {},
    ) => {
      setUp([]);
      const fixture = TestBed.createComponent(EnvironmentVariables);
      fixture.componentRef.setInput('environment', options.environment ?? environment());
      fixture.componentRef.setInput('canManage', options.canManage ?? true);
      fixture.componentRef.setInput('canDeploy', options.canDeploy ?? true);
      fixture.detectChanges();
      await settle();
      http
        .expectOne(`/api/v1/company/environments/${(options.environment ?? environment()).id}/variables`)
        .flush(options.variables ?? [SECRET, variable()]);
      await render(fixture);
      return fixture;
    };

    it('shows variables’ values, and only the names of secrets', async () => {
      const fixture = await open({ canManage: false });

      const rows = [...element(fixture).querySelectorAll('tbody tr')].map((row) =>
        [...row.querySelectorAll('td')].slice(0, 2).map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim()),
      );
      expect(rows).toEqual([
        ['DATABASE_URL', 'Secret ••••••••'],
        ['LOG_LEVEL', 'debug'],
      ]);
      expect(text(fixture)).toContain('by Taylor Lead');
      expect(text(fixture)).toContain('DREAMDEVOPS_ENVIRONMENT');
      // People who can't manage them can look, but not change anything.
      expect(button(fixture, 'Change LOG_LEVEL')).toBeUndefined();
      expect(element(fixture).querySelector('.variables-add')).toBeNull();
    });

    it('adds a variable, or a secret whose value is typed out of sight', async () => {
      const fixture = await open();
      const changed = vi.fn();
      fixture.componentInstance.changed.subscribe(changed);

      await type(fixture, fieldLabelled(fixture, 'Name'), 'API_TOKEN');
      element(fixture).querySelector<HTMLInputElement>('.variables-add input[type="checkbox"]')!.click();
      await render(fixture);
      expect(fieldLabelled(fixture, 'Value').type).toBe('password');
      expect(button(fixture, 'Add')!.disabled).toBe(true);
      await type(fixture, fieldLabelled(fixture, 'Value'), 'fake-dummy-token');
      button(fixture, 'Add')!.click();
      const request = http.expectOne('/api/v1/company/environments/e-1/variables');

      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ name: 'API_TOKEN', value: 'fake-dummy-token', secret: true });
      request.flush(variable({ id: 'v-3', name: 'API_TOKEN', secret: true, value: null }));
      await settle();
      http.expectOne('/api/v1/company/environments/e-1/variables').flush([SECRET, variable(), variable({ id: 'v-3', name: 'API_TOKEN', secret: true, value: null })]);
      await render(fixture);
      expect(text(fixture)).toContain('API_TOKEN is added. It applies the next time a version starts.');
      expect(text(fixture)).not.toContain('fake-dummy-token');
      expect(fieldLabelled(fixture, 'Name').value).toBe('');
      expect(changed).toHaveBeenCalledTimes(1);
    });

    it('says when a name won’t do', async () => {
      const fixture = await open();

      await type(fixture, fieldLabelled(fixture, 'Name'), '2FA-CODE');

      expect(text(fixture)).toContain('Use letters, digits and underscores, starting with a letter or underscore.');
      expect(button(fixture, 'Add')!.disabled).toBe(true);
    });

    it('replaces a secret from an empty field, and sends the version it was based on', async () => {
      const fixture = await open();

      button(fixture, 'Replace DATABASE_URL')!.click();
      await render(fixture);
      const field = fieldLabelled(fixture, 'New value of DATABASE_URL');
      expect(field.value).toBe('');
      expect(field.type).toBe('password');
      await type(fixture, field, 'postgres://new');
      button(fixture, 'Save')!.click();
      const request = http.expectOne('/api/v1/company/variables/v-2');

      expect(request.request.body).toEqual({ value: 'postgres://new', version: 4 });
      request.flush({ ...SECRET, version: 5 });
      await settle();
      http.expectOne('/api/v1/company/environments/e-1/variables').flush([{ ...SECRET, version: 5 }, variable()]);
      await render(fixture);
      expect(text(fixture)).toContain('DATABASE_URL is saved.');
    });

    it('asks before removing one', async () => {
      const fixture = await open();

      button(fixture, 'Remove LOG_LEVEL')!.click();
      await render(fixture);
      expect(text(fixture)).toContain('Remove the variable LOG_LEVEL from Staging?');
      button(fixture, 'Remove it')!.click();
      const request = http.expectOne('/api/v1/company/variables/v-1');

      expect(request.request.method).toBe('DELETE');
      expect(request.request.body).toEqual({ version: 1 });
      request.flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      http.expectOne('/api/v1/company/environments/e-1/variables').flush([SECRET]);
      await render(fixture);
      expect(text(fixture)).toContain("LOG_LEVEL is removed. Containers started from now on won't get it.");
    });

    it('asks for production’s name and a reason before any change to it', async () => {
      const fixture = await open({ environment: PRODUCTION });

      button(fixture, 'Change LOG_LEVEL')!.click();
      await render(fixture);
      await type(fixture, fieldLabelled(fixture, 'New value of LOG_LEVEL'), 'warn');
      button(fixture, 'Save')!.click();
      await render(fixture);
      http.expectNone('/api/v1/company/variables/v-1');
      expect(text(fixture)).toContain('Change the variable LOG_LEVEL of Production');
      await type(fixture, fieldLabelled(fixture, 'Type Production to confirm'), 'Production');
      await type(fixture, element(fixture).querySelector<HTMLTextAreaElement>('.production-confirmation textarea')!, REASON);
      button(fixture, 'Save the change')!.click();
      const request = http.expectOne('/api/v1/company/variables/v-1');

      expect(request.request.body).toEqual({ value: 'warn', confirmation: 'Production', reason: REASON, version: 1 });
      request.flush(variable({ value: 'warn', version: 2 }));
      await settle();
      http.expectOne('/api/v1/company/environments/e-2/variables').flush([variable({ value: 'warn', version: 2 })]);
      await render(fixture);
    });

    it('says when what runs has older settings, and offers to apply them', async () => {
      const fixture = await open({ environment: environment({ settingsPending: true }) });
      const apply = vi.fn();
      fixture.componentInstance.apply.subscribe(apply);

      expect(text(fixture)).toContain('1.5.0 started with older settings. Deploy it again to apply these.');
      button(fixture, 'Apply now')!.click();

      expect(apply).toHaveBeenCalledTimes(1);
    });
  });

  describe('on the Environments page', () => {
    it('opens an environment’s variables, and applies changes by deploying what runs again', async () => {
      setUp(['dashboards:view', 'environments:manage', 'deployments-test:run']);
      const fixture = TestBed.createComponent(Environments);
      fixture.detectChanges();
      await settle();
      http.expectOne((request) => request.url === '/api/v1/company/applications').flush([
        { id: 'a-1', name: 'Billing', slug: 'billing', type: { key: 'restful-service', name: 'RESTful Service' }, description: '', status: 'active', createdAt: '2026-11-01T10:00:00Z', createdBy: null, archivedAt: null },
      ]);
      http.expectOne((request) => request.url === '/api/v1/company/hosting-targets').flush([LOCAL]);
      await settle();
      http.expectOne((request) => request.url === '/api/v1/company/applications/a-1/environments').flush([environment({ settingsPending: true })]);
      http.expectOne((request) => request.url === '/api/v1/company/hosting-targets').flush([LOCAL]);
      await render(fixture);
      expect(text(fixture)).toContain('Variables changed since it started. Deploy it again to apply them.');

      button(fixture, 'Show variables of Staging')!.click();
      await render(fixture);
      http.expectOne('/api/v1/company/environments/e-1/variables').flush([variable()]);
      await render(fixture);
      button(fixture, 'Apply now')!.click();
      await render(fixture);
      http.expectOne('/api/v1/company/environments/e-1/versions').flush([
        { buildId: 'b-1.6.0', version: '1.6.0', kind: 'release', productive: true, builtAt: '2026-11-03T10:00:00Z', problem: null, live: false },
        { buildId: 'b-1.5.0', version: '1.5.0', kind: 'release', productive: true, builtAt: '2026-11-02T10:00:00Z', problem: null, live: true },
      ]);
      await render(fixture);

      // The version that runs is chosen, so it starts again with the new settings.
      expect(fieldLabelled(fixture, 'Version').value).toBe('b-1.5.0');
      expect(text(fixture)).toContain("It starts again with the environment's current variables and secrets.");
      fixture.destroy();
    });
  });

  it('describes changes in the audit log by name, never by value', () => {
    setUp([]);

    expect(
      describeEvent('EnvironmentVariableSet', {
        environmentName: 'Production',
        applicationName: 'Billing',
        production: true,
        name: 'DATABASE_URL',
        secret: true,
        change: 'changed',
        reason: REASON,
      }),
    ).toBe(`Changed the secret DATABASE_URL of the production environment "Production" of "Billing", because "${REASON}"`);
    expect(
      describeEvent('EnvironmentVariableRemoved', { environmentName: 'Staging', applicationName: 'Billing', production: false, name: 'LOG_LEVEL', secret: false }),
    ).toBe('Removed the variable LOG_LEVEL of the environment "Staging" of "Billing"');
  });
});
