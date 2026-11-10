import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describeEvent } from '../../core/events';
import { SessionService } from '../../core/session.service';
import { settle } from '../../testing';
import { Environments } from './environments';

const TARGET = {
  id: 't-1',
  status: 'connected',
  registrationExpiresAt: null,
  keyFingerprint: 'ab12:cd34:ef56:7890',
  agentVersion: '0.1.0',
  kubernetesVersion: 'v1.31.2+k3s1',
  registeredAt: '2026-11-09T10:00:00Z',
  lastSeenAt: '2026-11-09T10:05:00Z',
  createdAt: '2026-11-09T09:59:00Z',
};
const PRODUCTION = {
  id: 'e-1',
  name: 'Production',
  slug: 'production',
  kind: 'production',
  acceptsFeatureImages: false,
  acceptedImages: ['final'],
  status: 'active',
  createdAt: '2026-11-09T09:00:00Z',
  archivedAt: null,
  target: TARGET,
};
const STAGING = {
  ...PRODUCTION,
  id: 'e-2',
  name: 'Staging',
  slug: 'staging',
  kind: 'test',
  acceptsFeatureImages: true,
  acceptedImages: ['feature', 'rc', 'final'],
  target: null,
};
const CONNECTION = {
  targetId: 't-2',
  registrationToken: 't-2.secret',
  expiresAt: '2026-11-09T11:00:00Z',
  command: 'helm upgrade --install dreamdevops-agent oci://charts.test/agent --set registrationToken=t-2.secret',
};

describe('Environments', () => {
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
  const text = (fixture: ComponentFixture<unknown>) => element(fixture).textContent?.replace(/\s+/g, ' ') ?? '';
  const button = (fixture: ComponentFixture<unknown>, label: string) =>
    [...element(fixture).querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
    );
  const render = async (fixture: ComponentFixture<unknown>) => {
    await settle();
    await fixture.whenStable();
  };
  const answerList = async (environments: object[], status = 'active') => {
    await settle();
    const request = http.expectOne((candidate) => candidate.url === '/api/v1/company/environments');
    expect(request.request.params.get('status')).toBe(status);
    request.flush(environments);
  };
  const open = async (environments: object[] = [PRODUCTION, STAGING], manager = true) => {
    setUp(manager ? ['targets:connect'] : ['dashboards:view']);
    const fixture = TestBed.createComponent(Environments);
    fixture.detectChanges();
    await answerList(environments);
    await render(fixture);
    return fixture;
  };

  it('describes environment and target changes in the audit log', () => {
    setUp([]);
    expect(describeEvent('EnvironmentCreated', { name: 'Live', kind: 'production' })).toBe(
      'Created the production environment "Live"',
    );
    expect(describeEvent('EnvironmentUpdated', { acceptsFeatureImages: false })).toBe(
      'Stopped an environment from accepting feature images',
    );
    expect(describeEvent('TargetConnected', { environmentName: 'Live', keyFingerprint: 'ab12:cd34:ef56:7890' })).toBe(
      'Connected a target to "Live", key ab12:cd34:ef56:7890',
    );
    expect(describeEvent('TargetLost', { environmentName: 'Live' })).toBe('The target of "Live" stopped reporting');
    expect(describeEvent('TargetRevoked', { environmentName: 'Live', wasConnected: false })).toBe(
      'Cancelled connecting a target to "Live"',
    );
  });

  it('lists environments with what they accept and the health of their target', async () => {
    const fixture = await open();

    expect(text(fixture)).toContain('Final images');
    expect(text(fixture)).toContain('Feature, RC and final images');
    expect(text(fixture)).toContain('Connected');
    expect(text(fixture)).toContain('Kubernetes v1.31.2+k3s1, agent 0.1.0');
    expect(text(fixture)).toContain('ab12:cd34:ef56:7890');
    expect(text(fixture)).toContain('Not connected');
  });

  it('shows members without the permission the list only', async () => {
    const fixture = await open([PRODUCTION, STAGING], false);

    expect(text(fixture)).not.toContain('Create an environment');
    expect(button(fixture, 'Connect a target to Staging')).toBeUndefined();
    expect(button(fixture, 'Disconnect the target of Production')).toBeUndefined();
  });

  it('creates a production environment without feature images', async () => {
    const fixture = await open([]);
    const input = element(fixture).querySelector<HTMLInputElement>('input[formcontrolname="name"]')!;
    input.value = 'Live';
    input.dispatchEvent(new Event('input'));
    const kind = element(fixture).querySelector<HTMLSelectElement>('select[formcontrolname="kind"]')!;
    kind.value = 'production';
    kind.dispatchEvent(new Event('change'));
    await render(fixture);
    expect(text(fixture)).not.toContain('Accepts feature images');

    button(fixture, 'Create environment')!.click();
    await settle();
    const request = http.expectOne({ method: 'POST', url: '/api/v1/company/environments' });
    expect(request.request.body).toEqual({ name: 'Live', kind: 'production', acceptsFeatureImages: false });
    request.flush({ ...PRODUCTION, name: 'Live', target: null });
    await answerList([]);
    await render(fixture);

    expect(text(fixture)).toContain('Live is created. Connect a target to deploy to it.');
  });

  it('shows the connect command once, and keeps checking until the target connects', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      const fixture = await open();
      button(fixture, 'Connect a target to Staging')!.click();
      await settle();
      http.expectOne({ method: 'POST', url: '/api/v1/company/environments/e-2/target' }).flush(CONNECTION);
      const pending = { ...STAGING, target: { ...TARGET, id: 't-2', status: 'pending', registrationExpiresAt: CONNECTION.expiresAt } };
      await answerList([PRODUCTION, pending]);
      await render(fixture);

      const command = element(fixture).querySelector<HTMLTextAreaElement>('textarea[aria-label="Connect command"]')!;
      expect(command.value).toBe(CONNECTION.command);
      expect(text(fixture)).toContain('Waiting for the agent');
      expect(button(fixture, 'New command for Staging')).toBeDefined();

      await vi.advanceTimersByTimeAsync(5_000);
      await answerList([PRODUCTION, { ...STAGING, target: { ...TARGET, id: 't-2' } }]);
      await render(fixture);

      expect(element(fixture).querySelector('textarea[aria-label="Connect command"]')).toBeNull();
      expect(text(fixture)).toContain('The target of Staging is connected.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks before disconnecting a target', async () => {
    const fixture = await open();
    expect(button(fixture, 'Archive Production')).toBeUndefined();

    button(fixture, 'Disconnect the target of Production')!.click();
    await render(fixture);
    expect(text(fixture)).toContain("The agent's key and tokens stop working at once.");
    button(fixture, 'Confirm disconnecting')!.click();
    await settle();
    http.expectOne({ method: 'DELETE', url: '/api/v1/company/environments/e-1/target' }).flush(null);
    await answerList([{ ...PRODUCTION, target: null }, STAGING]);
    await render(fixture);

    expect(text(fixture)).toContain('The target of Production is disconnected.');
  });
});
