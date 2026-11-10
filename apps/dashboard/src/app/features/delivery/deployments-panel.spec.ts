import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describeEvent } from '../../core/events';
import { SessionService } from '../../core/session.service';
import { settle } from '../../testing';
import type { Deployment } from './delivery.api';
import { DeploymentsPanel, deploymentSteps } from './deployments-panel';

const environment = (id: string, name: string, kind: 'test' | 'production', acceptedImages: string[], status = 'connected') => ({
  id,
  name,
  slug: name.toLowerCase(),
  kind,
  acceptsFeatureImages: acceptedImages.includes('feature'),
  acceptedImages,
  requiresApproval: kind === 'production',
  status: 'active',
  createdAt: '2026-11-01T10:00:00Z',
  archivedAt: null,
  target: { id: `t-${id}`, status },
});
const STAGING = environment('e-1', 'Staging', 'test', ['feature', 'rc', 'final']);
const LIVE = environment('e-2', 'Live', 'production', ['final']);
const OFFLINE = environment('e-3', 'Offline', 'test', ['feature', 'rc', 'final'], 'lost');

const version = (id: string, kind: string, tag: string, versionLabel: string | null = null) => ({ id, kind, tag, version: versionLabel });
const VERSIONS = [version('b-1', 'feature', 'feature-login-abc1234'), version('b-2', 'final', '1.0.0', '1.0.0')];

const deployment = (overrides: Partial<Deployment> = {}): Deployment => ({
  id: 'd-1',
  application: { id: 'a-1', name: 'Billing', slug: 'billing' },
  environment: { id: 'e-1', name: 'Staging', kind: 'test' },
  version: { buildId: 'b-1', kind: 'feature', tag: 'feature-login-abc1234', version: null },
  strategy: 'rolling',
  status: 'progressing',
  message: null,
  progress: { applied: true, desired: 2, updated: 1, ready: 1, available: 1 },
  rollbackOf: null,
  commit: 'c'.repeat(40),
  requestedBy: { userId: 'u-2', displayName: 'Dana Developer' },
  approvedBy: null,
  createdAt: '2026-11-10T10:00:00Z',
  updatedAt: '2026-11-10T10:01:00Z',
  finishedAt: null,
  ...overrides,
});

describe('deployment steps', () => {
  const states = (value: Deployment) => deploymentSteps(value).map((step) => `${step.label}:${step.state}${step.detail ? ` (${step.detail})` : ''}`);

  it('follow a rolling deployment from Git to the target', () => {
    expect(states(deployment())).toEqual(['Saved to Git:passed (ccccccc)', 'Applied by the target:passed', 'Rolling out:running (1 of 2 ready)']);
    expect(states(deployment({ status: 'queued', commit: null, progress: {} }))).toEqual([
      'Saved to Git:running',
      'Applied by the target:waiting',
      'Rolling out:waiting',
    ]);
  });

  it('show approval, and the traffic switch of blue/green', () => {
    expect(states(deployment({ status: 'awaiting-approval', commit: null, progress: {} }))[0]).toBe('Approved:running');
    const paused = deployment({ strategy: 'blue-green', status: 'paused', approvedBy: { userId: 'u-3', displayName: 'Tara Lead' } });
    expect(states(paused)).toEqual([
      'Approved:passed (by Tara Lead)',
      'Saved to Git:passed (ccccccc)',
      'Applied by the target:passed',
      'Rolling out:passed (1 of 2 ready)',
      'Traffic switched:running',
    ]);
    expect(states(deployment({ strategy: 'blue-green', status: 'aborted' })).at(-1)).toBe('Traffic switched:failed');
  });

  it('are described in the audit log', () => {
    expect(describeEvent('DeploymentRequested', { strategy: 'blue-green', environmentName: 'Live', needsApproval: true })).toBe(
      'Asked for a blue-green deployment to "Live", which needs approval',
    );
    expect(describeEvent('EnvironmentSecretSet', { name: 'API_KEY', environmentName: 'Live', applicationId: 'a-1' })).toBe(
      'Set the secret API_KEY in "Live" for one application',
    );
  });
});

describe('DeploymentsPanel', () => {
  let http: HttpTestingController;

  const open = async (permissions: string[], deployments: Deployment[], userId = 'u-1') => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: SessionService,
          useValue: { user: () => ({ userId, permissions }), can: (permission: string) => permissions.includes(permission) },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(DeploymentsPanel);
    fixture.componentRef.setInput('application', 'a-1');
    fixture.componentRef.setInput('versions', VERSIONS);
    fixture.detectChanges();
    await settle();
    http.expectOne((request) => request.url === '/api/v1/company/environments').flush([STAGING, LIVE, OFFLINE]);
    await settle();
    http.expectOne((request) => request.url === '/api/v1/company/deployments').flush(deployments);
    await settle();
    await fixture.whenStable();
    return fixture;
  };

  afterEach(() => http.verify());

  const element = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
  const options = (fixture: ComponentFixture<unknown>, name: string) =>
    [...element(fixture).querySelectorAll<HTMLOptionElement>(`select[formcontrolname="${name}"] option`)].map((option) => option.textContent?.trim());
  const buttons = (fixture: ComponentFixture<unknown>) =>
    [...element(fixture).querySelectorAll('td.cell-actions button')].map((button) => button.textContent?.trim());

  it('offers only connected environments the person may deploy to, and the versions each accepts', async () => {
    const fixture = await open(['deployments-test:run'], []);

    expect(options(fixture, 'environment')).toEqual(['Staging (test)']);
    expect(options(fixture, 'version')).toEqual(['feature-login-abc1234', '1.0.0']);
    fixture.destroy();
  });

  it('deploys the chosen version with the chosen strategy', async () => {
    const fixture = await open(['deployments-test:run', 'deployments-production:run'], []);
    const select = element(fixture).querySelector<HTMLSelectElement>('select[formcontrolname="environment"]')!;
    select.value = 'e-2';
    select.dispatchEvent(new Event('change'));
    await settle();
    await fixture.whenStable();
    expect(options(fixture, 'version')).toEqual(['1.0.0']);
    expect(element(fixture).textContent).toContain('Someone else must approve each deployment.');

    element(fixture).querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle();
    const request = http.expectOne('/api/v1/company/applications/a-1/deployments');
    expect(request.request.body).toEqual({ environment: 'e-2', version: 'b-2', strategy: 'rolling' });
    request.flush(deployment({ status: 'awaiting-approval', environment: { id: 'e-2', name: 'Live', kind: 'production' } }));
    await settle();
    http.expectOne((candidate) => candidate.url === '/api/v1/company/deployments').flush([]);
    await settle();
    await fixture.whenStable();
    expect(element(fixture).textContent).toContain('The deployment to Live waits for someone to approve it.');
    fixture.destroy();
  });

  it('offers what can be done next, but no approving of your own deployment', async () => {
    const live = { id: 'e-2', name: 'Live', kind: 'production' as const };
    const fixture = await open(
      ['deployments-test:run', 'deployments-production:run'],
      [
        deployment({ id: 'd-3', strategy: 'blue-green', status: 'paused' }),
        deployment({ id: 'd-4', status: 'awaiting-approval', environment: live, requestedBy: { userId: 'u-1', displayName: 'Me' } }),
        deployment({ id: 'd-5', status: 'awaiting-approval', environment: live, application: { id: 'a-2', name: 'Web', slug: 'web' } }),
      ],
    );

    expect(buttons(fixture)).toEqual(['Switch traffic', 'Abort', 'Approve', 'Reject']);
    fixture.destroy();
  });

  it('offers to roll back only the newest finished deployment', async () => {
    const fixture = await open(['deployments-test:run'], [
      deployment({ id: 'd-2', status: 'succeeded' }),
      deployment({ id: 'd-1', status: 'succeeded' }),
    ]);

    expect(buttons(fixture)).toEqual(['Roll back']);
    element(fixture).querySelector<HTMLButtonElement>('td.cell-actions button')!.click();
    await settle();
    http.expectOne('/api/v1/company/deployments/d-2/rollback').flush(deployment({ id: 'd-6', status: 'queued' }));
    await settle();
    http.expectOne((candidate) => candidate.url === '/api/v1/company/deployments').flush([]);
    fixture.destroy();
  });
});
