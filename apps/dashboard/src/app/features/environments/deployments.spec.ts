import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { describeEvent } from '../../core/events';
import { SessionService } from '../../core/session.service';
import type { Step } from '../../shared/steps';
import { settle } from '../../testing';
import type { DeployOption, Deployment, Environment, HostingTarget } from './environments.api';
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

const LOCAL_PROVIDER = { key: 'local', name: 'This machine', kind: 'self-hosted' as const, deploys: true };
const CLOUD_PROVIDER = { key: 'aws', name: 'Amazon Web Services', kind: 'cloud' as const, deploys: false };

const target = (overrides: Partial<HostingTarget> = {}): HostingTarget => ({
  id: 't-local',
  name: 'This machine',
  provider: LOCAL_PROVIDER,
  settings: {},
  status: 'active',
  version: 1,
  environments: 2,
  running: 1,
  servesProduction: true,
  createdAt: '2026-11-01T10:00:00Z',
  archivedAt: null,
  ...overrides,
});
const LOCAL = target();
const CLOUD = target({
  id: 't-cloud',
  name: 'AWS account',
  provider: CLOUD_PROVIDER,
  settings: { accountId: '123456789012', region: 'eu-west-1' },
  environments: 0,
  running: 0,
  servesProduction: false,
});

const environment = (overrides: Partial<Environment> = {}): Environment => ({
  id: 'e-1',
  applicationId: 'a-1',
  name: 'Staging',
  slug: 'staging',
  production: false,
  status: 'active',
  version: 3,
  target: { id: LOCAL.id, name: LOCAL.name, provider: LOCAL_PROVIDER },
  live: null,
  deploying: null,
  variables: 0,
  settingsPending: false,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  archivedAt: null,
  ...overrides,
});
const live = (version: string, overrides: Partial<NonNullable<Environment['live']>> = {}): NonNullable<Environment['live']> => ({
  deploymentId: `d-${version}`,
  buildId: `b-${version}`,
  version,
  imageKind: 'release',
  productive: true,
  address: 'http://localhost:49153',
  target: { id: LOCAL.id, name: LOCAL.name },
  since: '2026-11-02T10:00:00Z',
  ...overrides,
});
const PRODUCTION = environment({ id: 'e-2', name: 'Production', slug: 'production', production: true, version: 7, live: live('1.4.0') });

const option = (version: string, kind: DeployOption['kind'], problem: string | null = null): DeployOption => ({
  buildId: `b-${version}`,
  version,
  kind,
  productive: kind === 'release',
  builtAt: '2026-11-02T09:00:00Z',
  problem,
  live: false,
});
const RELEASE = option('1.5.0', 'release');
const CANDIDATE_IN_PRODUCTION = option(
  '1.6.0-rc.1',
  'release-candidate',
  'Production is a production environment, so it runs only releases. 1.6.0-rc.1 is a release candidate.',
);

const STEP_NAMES: [string, string][] = [
  ['validate', 'Check the version and environment'],
  ['verify', 'Verify the signature'],
  ['pull', 'Pull the image'],
  ['start', 'Start the new version'],
  ['health', 'Wait until it’s healthy'],
];
/** The steps, with the first ones done and the next one under way. */
const steps = (done: number): Step[] =>
  STEP_NAMES.map(([key, name], index) => ({
    key,
    name,
    status: index < done ? 'passed' : index === done ? 'running' : 'pending',
    startedAt: index <= done ? '2026-11-02T10:00:00Z' : null,
    finishedAt: index < done ? '2026-11-02T10:00:05Z' : null,
    summary: key === 'health' && index < done ? '1.5.0 is healthy at http://localhost:49153.' : null,
    checks: key === 'verify' && index < done ? [{ name: "It matches the platform's key", outcome: 'passed', detail: 'sha256:abc' }] : [],
    facts: [],
  }));
const deployment = (overrides: Partial<Deployment> = {}): Deployment => ({
  id: 'd-new',
  environmentId: 'e-1',
  number: 2,
  kind: 'deploy',
  status: 'running',
  version: '1.5.0',
  imageKind: 'release',
  productive: true,
  image: `localhost:3000/acme/billing@sha256:${'a'.repeat(64)}`,
  production: false,
  target: { id: LOCAL.id, name: LOCAL.name, provider: LOCAL_PROVIDER },
  previousTarget: null,
  address: null,
  attempts: 1,
  lastError: null,
  requestedBy: { userId: 'u-1', displayName: 'Dana Developer' },
  reason: null,
  createdAt: '2026-11-02T10:00:00Z',
  startedAt: '2026-11-02T10:00:00Z',
  finishedAt: null,
  steps: steps(2),
  ...overrides,
});

const DEVELOPER = ['dashboards:view', 'deployments-test:run'];
const TECH_LEAD = ['dashboards:view', 'environments:manage', 'deployments-test:run', 'deployments-production:run'];
const REASON = 'Customers moved to the new service.';

describe('deployments', () => {
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
  const fieldLabelled = <T extends HTMLElement = HTMLInputElement>(fixture: ComponentFixture<unknown>, label: string) =>
    [...element(fixture).querySelectorAll('label')]
      .find((candidate) => candidate.querySelector('span')?.textContent?.trim() === label)!
      .querySelector<T & HTMLElement>('input, textarea, select')!;

  /** With fake timers: lets promises settle, and renders, so effects run. */
  const rendered = async (fixture: ComponentFixture<unknown>) => {
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
  };
  const answerList = async (environments: Environment[], targets = [LOCAL, CLOUD]) => {
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
    http.expectOne((request) => request.url === '/api/v1/company/hosting-targets').flush([LOCAL, CLOUD]);
    await answerList(environments);
    await render(fixture);
    return fixture;
  };

  describe('on the Environments page', () => {
    it('shows which version runs in each environment, and where to reach it', async () => {
      const moved = environment({
        target: { id: CLOUD.id, name: CLOUD.name, provider: CLOUD_PROVIDER },
        live: live('1.5.0-rc.1', { imageKind: 'release-candidate', productive: false, address: null }),
      });
      const fixture = await open(['dashboards:view'], [moved, PRODUCTION]);

      expect(text(fixture)).toContain('1.4.0 Release');
      const link = element(fixture).querySelector<HTMLAnchorElement>('a[href="http://localhost:49153"]');
      expect(link?.textContent).toBe('http://localhost:49153');
      expect(text(fixture)).toContain('1.5.0-rc.1 Release candidate');
      expect(text(fixture)).toContain('Still runs on This machine. Deploy again to move it.');
      // People who don't deploy can follow deployments, but not start one.
      expect(button(fixture, 'Deploy to Staging')).toBeUndefined();
      expect(button(fixture, 'Show deployments of Staging')).toBeDefined();
    });

    it('puts new environments on this machine unless someone chooses otherwise', async () => {
      const fixture = await open(TECH_LEAD, []);

      await type(fixture, fieldLabelled(fixture, 'Name'), 'Staging');
      button(fixture, 'Add environment')!.click();
      const request = http.expectOne('/api/v1/company/applications/a-1/environments');

      expect(request.request.body).toEqual({ name: 'Staging', production: false, targetId: LOCAL.id });
      request.flush(environment());
      await answerList([environment()]);
    });

    it('deploys a version to a test environment, and shows its steps as it goes', async () => {
      const fixture = await open(DEVELOPER);
      // Developers deploy to test environments only.
      expect(button(fixture, 'Deploy to Production')).toBeUndefined();
      expect(button(fixture, 'Stop 1.4.0 in Production')).toBeUndefined();

      button(fixture, 'Deploy to Staging')!.click();
      await render(fixture);
      http
        .expectOne('/api/v1/company/environments/e-1/versions')
        .flush([option('1.6.0-dev.pr9.1', 'development'), RELEASE]);
      await render(fixture);
      // The newest version is chosen already.
      expect(fieldLabelled<HTMLSelectElement>(fixture, 'Version').value).toBe('b-1.6.0-dev.pr9.1');
      await type(fixture, fieldLabelled<HTMLTextAreaElement>(fixture, 'Why (optional, kept in the audit log)'), 'Trying the CSV export');
      button(fixture, 'Deploy 1.6.0-dev.pr9.1')!.click();
      const request = http.expectOne('/api/v1/company/environments/e-1/deployments');
      expect(request.request.body).toEqual({ buildId: 'b-1.6.0-dev.pr9.1', reason: 'Trying the CSV export' });
      request.flush(deployment({ status: 'queued', version: '1.6.0-dev.pr9.1', imageKind: 'development', steps: steps(0) }));
      const deploying = environment({ deploying: { id: 'd-new', kind: 'deploy', status: 'queued', version: '1.6.0-dev.pr9.1' } });
      await answerList([deploying, PRODUCTION]);
      await render(fixture);
      http
        .expectOne('/api/v1/company/environments/e-1/deployments')
        .flush([deployment({ version: '1.6.0-dev.pr9.1', imageKind: 'development' })]);
      await render(fixture);

      expect(text(fixture)).toContain('1.6.0-dev.pr9.1 is being deployed to Staging. Follow its steps below.');
      expect(text(fixture)).toContain('Deploy 1.6.0-dev.pr9.1: Queued');
      expect(text(fixture)).toContain('Deploy 1.6.0-dev.pr9.1 to This machine: Running. 2 of 5 steps done. Now: Pull the image.');
      expect(text(fixture)).toContain('by Dana Developer');
      expect(element(fixture).querySelector('.pipeline-step[data-status="running"] .pipeline-name')?.textContent).toBe('Pull the image');
      fixture.destroy();
    });

    it('follows a deployment until it’s done, then shows where to reach it', async () => {
      vi.useFakeTimers();
      try {
        setUp(DEVELOPER);
        const fixture = TestBed.createComponent(Environments);
        fixture.detectChanges();
        await vi.advanceTimersByTimeAsync(0);
        http.expectOne((request) => request.url === '/api/v1/company/applications').flush([APPLICATION]);
        http.expectOne((request) => request.url === '/api/v1/company/hosting-targets').flush([LOCAL]);
        await vi.advanceTimersByTimeAsync(0);
        const deploying = environment({ deploying: { id: 'd-new', kind: 'deploy', status: 'running', version: '1.5.0' } });
        http.expectOne((request) => request.url === '/api/v1/company/applications/a-1/environments').flush([deploying]);
        http.expectOne((request) => request.url === '/api/v1/company/hosting-targets').flush([LOCAL]);
        await rendered(fixture);
        http.expectOne('/api/v1/company/environments/e-1/deployments').flush([deployment()]);
        await rendered(fixture);
        expect(text(fixture)).toContain('2 of 5 steps done. Now: Pull the image.');

        await vi.advanceTimersByTimeAsync(2_000);
        http.expectOne((request) => request.url === '/api/v1/company/applications/a-1/environments').flush([deploying]);
        http.expectOne((request) => request.url === '/api/v1/company/hosting-targets').flush([LOCAL]);
        await rendered(fixture);
        http.expectOne('/api/v1/company/environments/e-1/deployments').flush([deployment({ steps: steps(4) })]);
        await rendered(fixture);
        expect(text(fixture)).toContain('4 of 5 steps done. Now: Wait until it’s healthy.');

        await vi.advanceTimersByTimeAsync(2_000);
        const done = environment({ live: live('1.5.0', { deploymentId: 'd-new' }) });
        http.expectOne((request) => request.url === '/api/v1/company/applications/a-1/environments').flush([done]);
        http.expectOne((request) => request.url === '/api/v1/company/hosting-targets').flush([LOCAL]);
        await rendered(fixture);
        // Once it's done, its history loads one last time, and stays open while someone reads it.
        http
          .expectOne('/api/v1/company/environments/e-1/deployments')
          .flush([deployment({ status: 'succeeded', steps: steps(5), address: 'http://localhost:49153' })]);
        await vi.advanceTimersByTimeAsync(10_000);

        http.expectNone((request) => request.url === '/api/v1/company/applications/a-1/environments');
        expect(text(fixture)).toContain('1.5.0 Release');
        fixture.destroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it('offers production only releases, and asks for its name before deploying', async () => {
      const fixture = await open(TECH_LEAD);

      button(fixture, 'Deploy to Production')!.click();
      await render(fixture);
      http.expectOne('/api/v1/company/environments/e-2/versions').flush([CANDIDATE_IN_PRODUCTION, RELEASE]);
      await render(fixture);

      expect(text(fixture)).toContain('Production runs only releases');
      const options = [...fieldLabelled<HTMLSelectElement>(fixture, 'Version').querySelectorAll('option')];
      expect(options.find((candidate) => candidate.value === 'b-1.6.0-rc.1')?.disabled).toBe(true);
      expect(fieldLabelled<HTMLSelectElement>(fixture, 'Version').value).toBe('b-1.5.0');
      expect(text(fixture)).toContain('It replaces 1.4.0 once it\'s healthy. If it isn\'t, 1.4.0 runs again.');
      const deploy = button(fixture, 'Deploy 1.5.0')!;
      expect(deploy.disabled).toBe(true);
      await type(fixture, fieldLabelled(fixture, 'Type Production to confirm'), 'production');
      expect(deploy.disabled).toBe(true);
      await type(fixture, fieldLabelled(fixture, 'Type Production to confirm'), 'Production');
      expect(deploy.disabled).toBe(false);
      deploy.click();
      const request = http.expectOne('/api/v1/company/environments/e-2/deployments');

      expect(request.request.body).toEqual({ buildId: 'b-1.5.0', confirmation: 'Production' });
      request.flush(deployment({ environmentId: 'e-2', production: true, status: 'queued' }));
      await answerList([environment(), PRODUCTION]);
      await render(fixture);
      fixture.destroy();
    });

    it('stops production only with its name typed and a reason', async () => {
      const fixture = await open(TECH_LEAD);

      button(fixture, 'Stop 1.4.0 in Production')!.click();
      await render(fixture);
      expect(text(fixture)).toContain('Stop 1.4.0 in the production environment Production');
      const stop = button(fixture, 'Stop it')!;
      await type(fixture, fieldLabelled(fixture, 'Type Production to confirm'), 'Production');
      expect(stop.disabled).toBe(true);
      await type(fixture, element(fixture).querySelector<HTMLTextAreaElement>('.production-confirmation textarea')!, REASON);
      stop.click();
      const request = http.expectOne('/api/v1/company/environments/e-2/stop');

      expect(request.request.body).toEqual({ confirmation: 'Production', reason: REASON });
      request.flush(deployment({ kind: 'stop', environmentId: 'e-2', status: 'queued' }));
      await answerList([environment(), PRODUCTION]);
      await render(fixture);
      expect(text(fixture)).toContain('1.4.0 is being stopped in Production.');
      fixture.destroy();
    });

    it('doesn’t preselect an older version when the newest already runs', async () => {
      const fixture = await open(TECH_LEAD);

      button(fixture, 'Deploy to Production')!.click();
      await render(fixture);
      http
        .expectOne('/api/v1/company/environments/e-2/versions')
        .flush([{ ...option('1.4.0', 'release'), live: true }, option('1.3.0', 'release')]);
      await render(fixture);

      expect(fieldLabelled<HTMLSelectElement>(fixture, 'Version').value).toBe('');
      const panel = element(fixture).querySelector('.deploy-panel')!;
      expect([...panel.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Deploy')!.disabled).toBe(true);
      fixture.destroy();
    });

    it('keeps an environment that runs a candidate from becoming production', async () => {
      const candidate = environment({ live: live('1.5.0-rc.1', { imageKind: 'release-candidate', productive: false }) });
      const fixture = await open([...TECH_LEAD, 'environments-production:manage'], [candidate]);

      const makeProduction = button(fixture, 'Make production: Staging')!;

      expect(makeProduction.disabled).toBe(true);
      expect(makeProduction.title).toBe("It runs 1.5.0-rc.1, which isn't a release. Deploy a release to it, or stop it, first.");
    });

    it('explains why an environment can’t be deployed to yet', async () => {
      const unplaced = environment({ target: null });
      const inCloud = environment({
        id: 'e-3',
        name: 'Cloud test',
        target: { id: CLOUD.id, name: CLOUD.name, provider: CLOUD_PROVIDER },
      });
      const fixture = await open(DEVELOPER, [unplaced, inCloud]);

      expect(button(fixture, 'Deploy to Staging')!.disabled).toBe(true);
      expect(button(fixture, 'Deploy to Staging')!.title).toBe('Choose where it runs first');
      expect(button(fixture, 'Deploy to Cloud test')!.title).toBe("DreamDevOps can't deploy to Amazon Web Services targets yet");
    });
  });

  it('shows on the Hosting page which targets deploy, and what runs on each', async () => {
    setUp(['dashboards:view']);
    const fixture = TestBed.createComponent(HostingTargets);
    fixture.detectChanges();
    await settle();
    http.expectOne('/api/v1/company/hosting-providers').flush([]);
    await settle();
    http.expectOne((request) => request.url === '/api/v1/company/hosting-targets').flush([LOCAL, CLOUD]);
    await render(fixture);

    const rows = [...element(fixture).querySelectorAll('tbody tr')].map((row) => (row.textContent ?? '').replace(/\s+/g, ' '));
    expect(rows[0]).toContain('Deploys here');
    expect(rows[0]).toContain('1 running a version');
    expect(rows[1]).toContain('Deploying here comes later');
  });

  it('describes deployments in the audit log', () => {
    setUp([]);
    const payload = { environmentName: 'Production', applicationName: 'Billing', production: true, version: '1.5.0', targetName: 'This machine' };

    expect(describeEvent('DeploymentQueued', { ...payload, kind: 'deploy', reason: 'Monthly release' })).toBe(
      'Asked to deploy 1.5.0 to the production environment "Production" of "Billing", because "Monthly release"',
    );
    expect(describeEvent('DeploymentSucceeded', { ...payload, kind: 'deploy', address: 'http://localhost:49153' })).toBe(
      'Deployed 1.5.0 to the production environment "Production" of "Billing", at http://localhost:49153',
    );
    expect(describeEvent('DeploymentSucceeded', { ...payload, kind: 'move' })).toBe(
      'Moved 1.5.0 of the production environment "Production" of "Billing" to "This machine"',
    );
    expect(
      describeEvent('DeploymentFailed', { ...payload, kind: 'deploy', step: 'Wait until it’s healthy', error: 'Not healthy.', stillRunning: '1.4.0' }),
    ).toBe(
      'Deploying 1.5.0 to the production environment "Production" of "Billing" failed at "Wait until it’s healthy": Not healthy. 1.4.0 still runs',
    );
  });
});
