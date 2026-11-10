import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { describeEvent } from '../../core/events';
import { SessionService } from '../../core/session.service';
import { settle } from '../../testing';
import type { Environment, HostingProvider, HostingTarget } from './environments.api';
import { Environments } from './environments';
import { HostingTargets } from './hosting-targets';

const APPLICATION = {
  id: 'a-1',
  name: 'Billing',
  slug: 'billing',
  type: { key: 'restful-service', name: 'RESTful Service' },
  description: '',
  status: 'active',
  createdAt: '2026-11-01T10:00:00Z',
  createdBy: null,
  archivedAt: null,
};

const target = (overrides: Partial<HostingTarget> = {}): HostingTarget => ({
  id: 't-1',
  name: 'Office cluster',
  provider: { key: 'kubernetes', name: 'Kubernetes cluster', kind: 'self-hosted', deploys: false },
  settings: { apiServerUrl: 'https://k8s.example.com:6443' },
  status: 'active',
  version: 1,
  environments: 0,
  running: 0,
  servesProduction: false,
  createdAt: '2026-11-01T10:00:00Z',
  archivedAt: null,
  ...overrides,
});
const CLOUD = target({
  id: 't-2',
  name: 'AWS account',
  provider: { key: 'aws', name: 'Amazon Web Services', kind: 'cloud', deploys: false },
  settings: { accountId: '123456789012', region: 'eu-west-1' },
});

const environment = (overrides: Partial<Environment> = {}): Environment => ({
  id: 'e-1',
  applicationId: 'a-1',
  name: 'Staging',
  slug: 'staging',
  production: false,
  status: 'active',
  version: 3,
  target: {
    id: 't-1',
    name: 'Office cluster',
    provider: { key: 'kubernetes', name: 'Kubernetes cluster', kind: 'self-hosted', deploys: false },
  },
  live: null,
  deploying: null,
  variables: 0,
  settingsPending: false,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  archivedAt: null,
  ...overrides,
});
const PRODUCTION = environment({ id: 'e-2', name: 'Production', slug: 'production', production: true, version: 7 });

const PROVIDERS: HostingProvider[] = [
  {
    key: 'kubernetes',
    name: 'Kubernetes cluster',
    kind: 'self-hosted',
    description: 'A Kubernetes cluster you run.',
    deploys: false,
    settings: [
      { key: 'apiServerUrl', label: 'API server address', type: 'url', required: true, example: 'https://k8s.example.com:6443', help: null },
      { key: 'ingressDomain', label: 'Domain for applications', type: 'hostname', required: false, example: 'apps.example.com', help: 'Each environment gets an address under this domain.' },
    ],
  },
  {
    key: 'aws',
    name: 'Amazon Web Services',
    kind: 'cloud',
    description: 'An AWS account, in one region.',
    deploys: false,
    settings: [
      { key: 'accountId', label: 'Account ID', type: 'text', required: true, example: '123456789012', help: null },
      { key: 'region', label: 'Region', type: 'text', required: true, example: 'eu-west-1', help: null },
    ],
  },
];

const MANAGER = ['environments:manage'];
const PRODUCTION_MANAGER = ['environments:manage', 'environments-production:manage'];
const REASON = 'Moving production to the new account.';

describe('environments', () => {
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
  /** The field with this label, in the row being edited when there is one, so the create form isn't mistaken for it. */
  const fieldLabelled = <T extends HTMLElement = HTMLInputElement>(fixture: ComponentFixture<unknown>, label: string, scope?: Element) =>
    [...(scope ?? element(fixture)).querySelectorAll('label')]
      .find((candidate) => candidate.querySelector('span')?.textContent?.trim() === label)!
      .querySelector<T & HTMLElement>('input, textarea, select')!;
  const inputLabelled = (fixture: ComponentFixture<unknown>, label: string) =>
    fieldLabelled<HTMLInputElement | HTMLTextAreaElement>(fixture, label);
  /** The row that opens below the one being edited. */
  const openRow = (fixture: ComponentFixture<unknown>) => element(fixture).querySelector('td[colspan]')!;

  describe('the Environments page', () => {
    const answerList = async (environments: Environment[], targets = [target(), CLOUD]) => {
      await settle();
      http.expectOne((request) => request.url === '/api/v1/company/applications/a-1/environments').flush(environments);
      http.expectOne((request) => request.url === '/api/v1/company/hosting-targets').flush(targets);
      await settle();
    };
    const open = async (permissions: string[], environments: Environment[] = [environment(), PRODUCTION]) => {
      setUp(permissions);
      const fixture = TestBed.createComponent(Environments);
      fixture.detectChanges();
      await settle();
      http.expectOne((request) => request.url === '/api/v1/company/applications').flush([APPLICATION]);
      http.expectOne((request) => request.url === '/api/v1/company/hosting-targets').flush([target(), CLOUD]);
      await answerList(environments);
      await render(fixture);
      return fixture;
    };

    it('shows each environment, where it runs, and which are protected production', async () => {
      const fixture = await open(['dashboards:view']);

      expect(text(fixture)).toContain('Staging staging Office cluster Kubernetes cluster · Self-hosted');
      const productionRow = element(fixture).querySelector('tr[data-production="true"]')!;
      expect(productionRow.querySelector('[data-tone="production"]')?.textContent).toBe('Production, protected');
      expect(productionRow.querySelector('code')?.textContent).toBe('production');
      expect(element(fixture).querySelectorAll('tr[data-production="true"]')).toHaveLength(1);
      // Members who can't manage environments can look, but not change anything.
      expect(text(fixture)).not.toContain('Add an environment');
      expect(button(fixture, 'Edit Staging')).toBeUndefined();
    });

    it('adds an environment on a chosen target', async () => {
      const fixture = await open(MANAGER, []);
      // Only people who manage production are offered to add it.
      expect(element(fixture).querySelector('input[type="checkbox"]')).toBeNull();

      await type(fixture, inputLabelled(fixture, 'Name'), 'Staging');
      const select = inputLabelled(fixture, 'Name').closest('.form-row')!.querySelector('select')!;
      select.value = 't-2';
      select.dispatchEvent(new Event('change'));
      button(fixture, 'Add environment')!.click();
      const request = http.expectOne('/api/v1/company/applications/a-1/environments');
      expect(request.request.body).toEqual({ name: 'Staging', production: false, targetId: 't-2' });
      request.flush(environment());
      await answerList([environment()]);
      await render(fixture);

      expect(text(fixture)).toContain('Staging is added.');
    });

    it('lets people who manage production add a production environment', async () => {
      const fixture = await open(PRODUCTION_MANAGER, []);

      await type(fixture, inputLabelled(fixture, 'Name'), 'Production');
      const production = element(fixture).querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      production.checked = true;
      production.dispatchEvent(new Event('change'));
      await render(fixture);
      expect(text(fixture)).toContain('Production is protected from the start');
      button(fixture, 'Add environment')!.click();
      const request = http.expectOne('/api/v1/company/applications/a-1/environments');
      expect(request.request.body).toEqual({ name: 'Production', production: true, targetId: null });
      request.flush(PRODUCTION);
      await answerList([PRODUCTION]);
      await render(fixture);

      expect(text(fixture)).toContain('Production is added as a protected production environment.');
    });

    it('saves a non-production change at once, sending only what changed and the version it was based on', async () => {
      const fixture = await open(MANAGER);

      button(fixture, 'Edit Staging')!.click();
      await render(fixture);
      const runsOn = fieldLabelled<HTMLSelectElement>(fixture, 'Runs on', openRow(fixture));
      runsOn.value = 't-2';
      runsOn.dispatchEvent(new Event('change'));
      button(fixture, 'Save')!.click();
      const request = http.expectOne('/api/v1/company/environments/e-1');
      expect(request.request.body).toEqual({ targetId: 't-2', version: 3 });
      request.flush(environment({ target: { id: 't-2', name: 'AWS account', provider: CLOUD.provider } }));
      await answerList([environment()]);
      await render(fixture);

      expect(text(fixture)).toContain('Staging is saved.');
    });

    it('asks for production’s name and a reason before saving a change to it', async () => {
      const fixture = await open(PRODUCTION_MANAGER);

      button(fixture, 'Edit Production')!.click();
      await render(fixture);
      await type(fixture, inputLabelled(fixture, 'Name of Production'), 'Live');
      button(fixture, 'Save')!.click();
      await render(fixture);
      http.expectNone('/api/v1/company/environments/e-2');
      expect(text(fixture)).toContain('This affects production. To confirm, type Production exactly, and say why.');

      const confirm = button(fixture, 'Save the change')!;
      await type(fixture, inputLabelled(fixture, 'Type Production to confirm'), 'production');
      await type(fixture, element(fixture).querySelector<HTMLTextAreaElement>('.production-confirmation textarea')!, REASON);
      expect(confirm.disabled).toBe(true);
      await type(fixture, inputLabelled(fixture, 'Type Production to confirm'), 'Production');
      expect(confirm.disabled).toBe(false);
      confirm.click();
      const request = http.expectOne('/api/v1/company/environments/e-2');
      expect(request.request.body).toEqual({ name: 'Live', confirmation: 'Production', reason: REASON, version: 7 });
      request.flush({ ...PRODUCTION, name: 'Live' });
      await answerList([environment(), { ...PRODUCTION, name: 'Live' }]);
      await render(fixture);

      expect(text(fixture)).toContain('Live is saved. The reason is in the audit log.');
    });

    it('removes production protection only once confirmed, and never offers to archive production', async () => {
      const fixture = await open(PRODUCTION_MANAGER);
      expect(button(fixture, 'Archive Production')).toBeUndefined();
      expect(button(fixture, 'Archive Staging')).toBeDefined();
      expect(text(fixture)).toContain("Production environments can't be archived. Remove their protection first.");

      button(fixture, 'Remove production protection from Production')!.click();
      await render(fixture);
      await type(fixture, inputLabelled(fixture, 'Type Production to confirm'), 'Production');
      await type(fixture, element(fixture).querySelector<HTMLTextAreaElement>('.production-confirmation textarea')!, REASON);
      button(fixture, 'Remove protection')!.click();
      const request = http.expectOne('/api/v1/company/environments/e-2/unprotect');
      expect(request.request.body).toEqual({ confirmation: 'Production', reason: REASON, version: 7 });
      request.flush({ ...PRODUCTION, production: false });
      await answerList([environment(), { ...PRODUCTION, production: false }]);
      await render(fixture);

      expect(text(fixture)).toContain('Production is no longer production.');
    });

    it('makes an environment production, with an optional reason', async () => {
      const fixture = await open(PRODUCTION_MANAGER);

      button(fixture, 'Make production: Staging')!.click();
      await render(fixture);
      button(fixture, 'Make production')!.click();
      const request = http.expectOne('/api/v1/company/environments/e-1/protect');
      expect(request.request.body).toEqual({ version: 3 });
      request.flush({ ...environment(), production: true });
      await answerList([{ ...environment(), production: true }]);
      await render(fixture);

      expect(text(fixture)).toContain('Staging is now a protected production environment.');
    });

    it('keeps production out of reach of people who manage only other environments', async () => {
      const fixture = await open(MANAGER);

      expect(button(fixture, 'Edit Staging')).toBeDefined();
      expect(button(fixture, 'Edit Production')).toBeUndefined();
      expect(button(fixture, 'Make production: Staging')).toBeUndefined();
      expect(button(fixture, 'Remove production protection from Production')).toBeUndefined();
      expect(element(fixture).querySelector('input[type="checkbox"]')).toBeNull();
    });

    it('explains a change someone else made meanwhile, and reloads so the next try is current', async () => {
      const fixture = await open(MANAGER);

      button(fixture, 'Archive Staging')!.click();
      await render(fixture);
      button(fixture, 'Confirm archiving')!.click();
      http
        .expectOne('/api/v1/company/environments/e-1/archive')
        .flush(
          { status: 409, detail: 'Someone else changed this meanwhile. Reload it and try again.' },
          { status: 409, statusText: 'Conflict' },
        );
      await answerList([environment({ version: 4 }), PRODUCTION]);
      await render(fixture);

      expect(text(fixture)).toContain('Someone else changed this meanwhile. Reload it and try again.');
    });
  });

  describe('the Hosting page', () => {
    const answerTargets = async (targets: HostingTarget[]) => {
      await settle();
      http.expectOne((request) => request.url === '/api/v1/company/hosting-targets').flush(targets);
      await settle();
    };
    const open = async (permissions: string[], targets: HostingTarget[] = [target(), CLOUD]) => {
      setUp(permissions);
      const fixture = TestBed.createComponent(HostingTargets);
      fixture.detectChanges();
      await settle();
      http.expectOne('/api/v1/company/hosting-providers').flush(PROVIDERS);
      await answerTargets(targets);
      await render(fixture);
      return fixture;
    };

    it('shows each target, its provider and settings, and where production runs', async () => {
      const fixture = await open(['dashboards:view'], [target({ servesProduction: true, environments: 2 }), CLOUD]);

      expect(text(fixture)).toContain('Office cluster Kubernetes cluster · Self-hosted');
      expect(text(fixture)).toContain('API server address: https://k8s.example.com:6443');
      expect(text(fixture)).toContain('AWS account Amazon Web Services · Cloud');
      expect(text(fixture)).toContain('Region: eu-west-1');
      expect(text(fixture)).toContain('2 Production runs here');
      expect(text(fixture)).not.toContain('Connect a hosting target');
    });

    it('connects a target from any provider, asking for that provider’s settings', async () => {
      const fixture = await open(['targets:connect'], []);
      const groups = [...element(fixture).querySelectorAll('optgroup')].map((group) => group.label);
      expect(groups).toEqual(['Self-hosted', 'Cloud']);
      expect(text(fixture)).toContain('API server address');

      const provider = element(fixture).querySelector<HTMLSelectElement>('select')!;
      provider.value = 'aws';
      provider.dispatchEvent(new Event('change'));
      await render(fixture);
      expect(text(fixture)).toContain('An AWS account, in one region.');
      expect(text(fixture)).not.toContain('API server address');
      await type(fixture, inputLabelled(fixture, 'Name'), 'AWS account');
      await type(fixture, inputLabelled(fixture, 'Account ID'), '123456789012');
      expect(button(fixture, 'Connect target')!.disabled).toBe(true);
      await type(fixture, inputLabelled(fixture, 'Region'), 'eu-west-1');
      button(fixture, 'Connect target')!.click();
      const request = http.expectOne((candidate) => candidate.method === 'POST');
      expect(request.request.body).toEqual({
        name: 'AWS account',
        provider: 'aws',
        settings: { accountId: '123456789012', region: 'eu-west-1' },
      });
      request.flush(CLOUD);
      await answerTargets([CLOUD]);
      await render(fixture);

      expect(text(fixture)).toContain('AWS account is connected. Environments can run on it now.');
    });

    it('asks for the name and a reason before changing a target production runs on', async () => {
      const serving = target({ servesProduction: true, environments: 1 });
      const fixture = await open(['targets:connect'], [serving]);

      button(fixture, 'Edit Office cluster')!.click();
      await render(fixture);
      expect(text(fixture)).toContain('Production runs here, so saving will ask for its name and a reason.');
      await type(fixture, fieldLabelled(fixture, 'API server address', openRow(fixture)), 'https://k8s-2.example.com');
      button(fixture, 'Save')!.click();
      await render(fixture);
      http.expectNone((candidate) => candidate.method === 'PATCH');
      await type(fixture, inputLabelled(fixture, 'Type Office cluster to confirm'), 'Office cluster');
      await type(fixture, element(fixture).querySelector<HTMLTextAreaElement>('.production-confirmation textarea')!, REASON);
      button(fixture, 'Save the change')!.click();
      const request = http.expectOne('/api/v1/company/hosting-targets/t-1');
      expect(request.request.body).toEqual({
        name: 'Office cluster',
        settings: { apiServerUrl: 'https://k8s-2.example.com' },
        confirmation: 'Office cluster',
        reason: REASON,
        version: 1,
      });
      request.flush({ ...serving, version: 2 });
      await answerTargets([{ ...serving, version: 2 }]);
      await render(fixture);

      expect(text(fixture)).toContain('Office cluster is saved, and the reason is in the audit log.');
    });

    it('offers to archive only targets no environment runs on', async () => {
      const fixture = await open(['targets:connect'], [target({ environments: 1 }), CLOUD]);

      expect(button(fixture, 'Archive Office cluster')!.disabled).toBe(true);
      expect(button(fixture, 'Archive Office cluster')!.title).toBe('Move or stop what runs on it first');
      button(fixture, 'Archive AWS account')!.click();
      await render(fixture);
      button(fixture, 'Confirm archiving')!.click();
      const request = http.expectOne('/api/v1/company/hosting-targets/t-2/archive');
      expect(request.request.body).toEqual({ version: 1 });
      request.flush({ ...CLOUD, status: 'archived' });
      await answerTargets([target({ environments: 1 })]);
      await render(fixture);

      expect(text(fixture)).toContain('AWS account is archived.');
    });
  });

  it('describes every change in the audit log, with the reason given for production', () => {
    setUp([]);
    const production = { name: 'Production', applicationName: 'Billing' };

    expect(describeEvent('EnvironmentUnprotected', { ...production, reason: REASON })).toBe(
      `Removed production protection from the environment "Production" of "Billing", because "${REASON}"`,
    );
    expect(describeEvent('EnvironmentTargetSwitched', { ...production, reason: null })).toBe(
      'Moved the environment "Production" of "Billing" to another hosting target',
    );
    expect(describeEvent('HostingTargetUpdated', { name: 'AWS', servesProduction: true, reason: REASON })).toBe(
      `Changed the hosting target "AWS", which production runs on, because "${REASON}"`,
    );
  });
});
