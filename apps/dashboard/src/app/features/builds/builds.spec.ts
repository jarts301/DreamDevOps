import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { describeEvent } from '../../core/events';
import { SessionService } from '../../core/session.service';
import { settle } from '../../testing';
import { buildTone, duration, stepTone } from './build-labels';
import { Builds } from './builds';
import type { Build, BuildStep } from './builds.api';

const BILLING = {
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
const SHOP = { ...BILLING, id: 'a-2', name: 'Shop', slug: 'shop' };
const repository = (applicationId: string, status = 'ready') => ({
  applicationId,
  status,
  fullName: `acme/${applicationId}`,
  url: `http://git.test/acme/${applicationId}`,
  blueprint: null,
  lastError: null,
});

const step = (key: string, name: string, status: BuildStep['status'], extra: Partial<BuildStep> = {}): BuildStep => ({
  key,
  name,
  status,
  startedAt: status === 'pending' ? null : '2026-11-08T10:00:00Z',
  finishedAt: status === 'pending' || status === 'running' ? null : '2026-11-08T10:00:42Z',
  summary: null,
  checks: [],
  facts: [],
  ...extra,
});

const STEP_NAMES: [string, string][] = [
  ['checkout', 'Get the source'],
  ['validate', 'Validate the version and Dockerfile'],
  ['build', 'Build the image'],
  ['inspect', 'Check the image'],
  ['scan', 'Scan for vulnerabilities'],
  ['publish', 'Publish to the registry'],
  ['sign', 'Sign the image'],
  ['verify', 'Verify the signature'],
];
const steps = (done: number, current: BuildStep['status'] = 'running') =>
  STEP_NAMES.map(([key, name], index) =>
    step(key, name, index < done ? 'passed' : index === done ? current : 'pending'),
  );

const build = (overrides: Partial<Build> = {}): Build => ({
  id: 'b-1',
  applicationId: 'a-1',
  number: 1,
  kind: 'development',
  version: '0.1.0-dev.pr7.1',
  status: 'succeeded',
  branch: 'feature/login',
  pullRequest: 7,
  commit: 'c'.repeat(40),
  image: 'localhost:3000/acme/billing:0.1.0-dev.pr7.1',
  digest: `sha256:${'d'.repeat(64)}`,
  attempts: 1,
  lastError: null,
  requestedBy: { userId: 'u-1', displayName: 'Dana Developer' },
  createdAt: '2026-11-08T10:00:00Z',
  startedAt: '2026-11-08T10:00:00Z',
  finishedAt: '2026-11-08T10:05:00Z',
  steps: steps(8),
  ...overrides,
});

const VERSIONS = {
  onMain: '1.3.0',
  published: '1.3.0',
  next: { minor: '1.4.0', major: '2.0.0', hotfix: '1.3.1' },
  lines: [
    {
      kind: 'release',
      branch: 'release/1.4.0',
      version: '1.4.0',
      latestCandidate: { id: 'b-2', version: '1.4.0-rc.1', status: 'succeeded' },
    },
  ],
};
const PULL_REQUEST = {
  number: 7,
  title: 'Add login',
  branch: 'feature/login',
  url: 'http://git.test/acme/billing/pulls/7',
  commit: 'c'.repeat(40),
  latestBuild: null,
};
const KEY = {
  algorithm: 'ECDSA P-256 with SHA-256',
  fingerprint: `sha256:${'f'.repeat(64)}`,
  publicKey: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n',
};

describe('Builds', () => {
  let http: HttpTestingController;

  const setUp = (permissions: string[], query: Record<string, string> = {}) => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: SessionService,
          useValue: { user: () => ({ permissions }), can: (permission: string) => permissions.includes(permission) },
        },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } },
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
  /** Answers the requests that load one application's builds. */
  const answerApplication = async (
    applicationId: string,
    answers: { builds?: Build[]; versions?: object; pullRequests?: object[] | 'fail' } = {},
  ) => {
    await settle();
    http.expectOne(`/api/v1/company/applications/${applicationId}/builds/sync`).flush({ found: 0 });
    await settle();
    http.expectOne(`/api/v1/company/applications/${applicationId}/builds`).flush(answers.builds ?? [build()]);
    const pullRequests = http.expectOne(`/api/v1/company/applications/${applicationId}/pull-requests`);
    if (answers.pullRequests === 'fail') {
      pullRequests.flush(
        { status: 503, detail: 'The Git service could not be reached.' },
        { status: 503, statusText: 'Service Unavailable' },
      );
    } else {
      pullRequests.flush(answers.pullRequests ?? [PULL_REQUEST]);
    }
    await settle();
    http.expectOne(`/api/v1/company/applications/${applicationId}/versions`).flush(answers.versions ?? VERSIONS);
  };
  const open = async (
    permissions: string[],
    answers: Parameters<typeof answerApplication>[1] & { query?: Record<string, string> } = {},
  ) => {
    setUp(permissions, answers.query);
    const fixture = TestBed.createComponent(Builds);
    fixture.detectChanges();
    await settle();
    http.expectOne((candidate) => candidate.url === '/api/v1/company/applications').flush([BILLING, SHOP]);
    http.expectOne('/api/v1/company/repositories').flush([repository('a-1'), repository('a-2')]);
    await settle();
    http.expectOne('/api/v1/company/image-signing-key').flush(KEY);
    await answerApplication(answers.query?.['application'] ?? 'a-1', answers);
    await render(fixture);
    return fixture;
  };

  it('describes build and release events in the audit log', () => {
    setUp([]);
    expect(describeEvent('ReleaseStarted', { name: 'Billing', version: '1.4.0', branch: 'release/1.4.0' })).toBe(
      'Started release 1.4.0 of "Billing" on release/1.4.0',
    );
    expect(describeEvent('BuildSucceeded', { name: 'Billing', kind: 'release', version: '1.4.0', image: 'r/acme/billing:1.4.0' })).toBe(
      'Released version 1.4.0 of "Billing" as r/acme/billing:1.4.0',
    );
    expect(describeEvent('BuildFailed', { name: 'Billing', version: '1.4.0-rc.1', step: 'Scan for vulnerabilities', reason: 'Found 1.' })).toBe(
      'Building 1.4.0-rc.1 of "Billing" failed at "Scan for vulnerabilities": Found 1.',
    );
    expect(describeEvent('BuildQueued', { name: 'Billing', version: '1.4.0-rc.1', branch: 'release/1.4.0' })).toBe(
      'Asked to build 1.4.0-rc.1 of "Billing" from release/1.4.0',
    );
  });

  it('formats how long a step took', () => {
    setUp([]);
    expect(duration('2026-11-08T10:00:00Z', '2026-11-08T10:00:42Z')).toBe('42s');
    expect(duration('2026-11-08T10:00:00Z', '2026-11-08T10:03:05Z')).toBe('3m 05s');
    expect(duration('2026-11-08T10:00:00Z', null, Date.parse('2026-11-08T10:00:07Z'))).toBe('7s');
    expect(duration(null, null)).toBeNull();
  });

  it('colors statuses by what they mean, not by any one screen’s states', () => {
    setUp([]);
    expect(['succeeded', 'failed', 'queued', 'running'].map((status) => buildTone(status as Build['status']))).toEqual([
      'success',
      'danger',
      'progress',
      'progress',
    ]);
    expect(['passed', 'failed', 'running', 'pending', 'skipped'].map((status) => stepTone(status as BuildStep['status']))).toEqual([
      'success',
      'danger',
      'progress',
      null,
      null,
    ]);
  });

  it('shows versions, releases in progress, feature pull requests and builds', async () => {
    const fixture = await open(['dashboards:view']);

    expect(text(fixture)).toContain('The latest release is 1.3.0, published and signed.');
    expect(text(fixture)).toContain('Release 1.4.0 release/1.4.0');
    expect(text(fixture)).toContain('1.4.0-rc.1 Succeeded');
    expect(text(fixture)).toContain('#7 Add login');
    expect(text(fixture)).toContain('0.1.0-dev.pr7.1 Development Succeeded');
    expect(text(fixture)).toContain('by Dana Developer');
    // Viewers can follow everything, but not start anything.
    expect(button(fixture, 'Start release 1.4.0')).toBeUndefined();
    expect(button(fixture, 'Build a development image of pull request 7')).toBeUndefined();
    expect(button(fixture, 'Build a new candidate from release/1.4.0')).toBeUndefined();
  });

  it("opens the newest build's progress, with each step, check and result", async () => {
    const validated = step('validate', 'Validate the version and Dockerfile', 'passed', {
      summary: '8 checks passed, with 1 warning.',
      checks: [
        { name: 'Base images are pinned by digest', outcome: 'passed', detail: '2 base images, all pinned.' },
        { name: 'The repository has a .dockerignore file', outcome: 'warning', detail: 'Without one, every file is sent.' },
      ],
    });
    const signed = step('sign', 'Sign the image', 'passed', {
      facts: [{ label: 'Key fingerprint', value: KEY.fingerprint }],
    });
    const done = build({ steps: steps(8).map((entry) => (entry.key === 'validate' ? validated : entry.key === 'sign' ? signed : entry)) });
    const fixture = await open(['dashboards:view'], { builds: [done] });

    expect(button(fixture, 'Hide progress of 0.1.0-dev.pr7.1')?.getAttribute('aria-expanded')).toBe('true');
    expect(text(fixture)).toContain('8 of 8 steps done.');
    expect(text(fixture)).toContain('localhost:3000/acme/billing:0.1.0-dev.pr7.1');
    const names = [...element(fixture).querySelectorAll('.pipeline-name')].map((entry) => entry.textContent);
    expect(names).toEqual(STEP_NAMES.map(([, name]) => name));
    const checks = element(fixture).querySelector('[aria-label="Checks for Validate the version and Dockerfile"]')!;
    expect(checks.textContent?.replace(/\s+/g, ' ')).toContain('Passed: Base images are pinned by digest. 2 base images, all pinned.');
    expect(checks.textContent?.replace(/\s+/g, ' ')).toContain('Warning: The repository has a .dockerignore file');
    const fact = [...element(fixture).querySelectorAll('.fact-list dt')].find((term) => term.textContent === 'Key fingerprint');
    expect(fact?.nextElementSibling?.textContent).toBe(KEY.fingerprint);
    expect(text(fixture)).toContain('42s');

    button(fixture, 'Hide progress of 0.1.0-dev.pr7.1')!.click();
    await render(fixture);
    expect(element(fixture).querySelector('.pipeline')).toBeNull();
  });

  it('follows a running build until it finishes', async () => {
    vi.useFakeTimers();
    try {
      setUp(['dashboards:view']);
      const fixture = TestBed.createComponent(Builds);
      fixture.detectChanges();
      await vi.advanceTimersByTimeAsync(0);
      http.expectOne((candidate) => candidate.url === '/api/v1/company/applications').flush([BILLING]);
      http.expectOne('/api/v1/company/repositories').flush([repository('a-1')]);
      await vi.advanceTimersByTimeAsync(0);
      http.expectOne('/api/v1/company/image-signing-key').flush(KEY);
      http.expectOne('/api/v1/company/applications/a-1/builds/sync').flush({ found: 0 });
      await vi.advanceTimersByTimeAsync(0);
      const running = build({ status: 'running', steps: steps(2), image: null, digest: null, finishedAt: null });
      http.expectOne('/api/v1/company/applications/a-1/builds').flush([running]);
      http.expectOne('/api/v1/company/applications/a-1/pull-requests').flush([]);
      await vi.advanceTimersByTimeAsync(0);
      http.expectOne('/api/v1/company/applications/a-1/versions').flush(VERSIONS);
      await vi.advanceTimersByTimeAsync(0);

      expect(text(fixture)).toContain('Development 0.1.0-dev.pr7.1: Running. 2 of 8 steps done. Now: Build the image.');
      expect(element(fixture).querySelector('progress')?.getAttribute('value')).toBe('2');
      expect(element(fixture).querySelector('.pipeline-step[data-status="running"] .pipeline-name')?.textContent).toBe(
        'Build the image',
      );

      await vi.advanceTimersByTimeAsync(2_000);
      http.expectOne('/api/v1/company/applications/a-1/builds').flush([{ ...running, steps: steps(5) }]);
      await vi.advanceTimersByTimeAsync(0);
      // Versions can only change when a build's status does, so they aren't asked for again yet.
      http.expectNone('/api/v1/company/applications/a-1/versions');
      expect(text(fixture)).toContain('5 of 8 steps done. Now: Publish to the registry.');
      // Polling doesn't mark the page busy, so nothing flickers.
      expect(button(fixture, 'Hide progress of 0.1.0-dev.pr7.1')?.disabled).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      http.expectOne('/api/v1/company/applications/a-1/builds').flush([build()]);
      await vi.advanceTimersByTimeAsync(0);
      http.expectOne('/api/v1/company/applications/a-1/versions').flush(VERSIONS);
      await vi.advanceTimersByTimeAsync(10_000);

      http.expectNone('/api/v1/company/applications/a-1/builds');
      expect(text(fixture)).toContain('8 of 8 steps done.');
      fixture.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows why a build failed, and lets people with permission try again', async () => {
    const failedScan = step('scan', 'Scan for vulnerabilities', 'failed', {
      summary: 'Found 1 critical vulnerability.',
      checks: [
        {
          name: 'No critical vulnerabilities',
          outcome: 'failed',
          detail: '1 found: CVE-2026-0001 in openssl 3.0.1 (fixed in 3.0.2).',
        },
      ],
    });
    const failed = build({
      status: 'failed',
      lastError: 'Found 1 critical vulnerability.',
      image: null,
      digest: null,
      steps: steps(4).map((entry) => (entry.key === 'scan' ? failedScan : entry)),
    });
    const fixture = await open(['feature-images:build'], { builds: [failed] });

    expect(text(fixture)).toContain('Failed: No critical vulnerabilities. 1 found: CVE-2026-0001 in openssl 3.0.1 (fixed in 3.0.2).');
    expect(text(fixture)).toContain('Scan for vulnerabilities: Failed, took 42s');
    expect(element(fixture).querySelector('.pipeline-step[data-status="failed"] .pipeline-symbol')?.textContent).toBe('✗');

    button(fixture, 'Try building 0.1.0-dev.pr7.1 again')!.click();
    const retry = http.expectOne('/api/v1/company/builds/b-1/retry');
    expect(retry.request.method).toBe('POST');
    retry.flush({ ...failed, status: 'queued' });
    await settle();
    http.expectOne('/api/v1/company/applications/a-1/builds').flush([build()]);
    await settle();
    http.expectOne('/api/v1/company/applications/a-1/versions').flush(VERSIONS);
    await settle();
    http.expectOne('/api/v1/company/applications/a-1/pull-requests').flush([PULL_REQUEST]);
    await render(fixture);

    expect(text(fixture)).toContain('0.1.0-dev.pr7.1 is being built again.');
  });

  it('does not offer to try a release again without permission to start releases', async () => {
    const failed = build({ kind: 'release', version: '1.4.0', status: 'failed', steps: steps(1, 'failed') });
    const fixture = await open(['feature-images:build'], { builds: [failed] });

    expect(button(fixture, 'Try building 1.4.0 again')).toBeUndefined();
  });

  it('builds a development image of a feature pull request', async () => {
    const fixture = await open(['feature-images:build'], { builds: [], pullRequests: [PULL_REQUEST] });
    expect(text(fixture)).toContain('None yet');

    button(fixture, 'Build a development image of pull request 7')!.click();
    const request = http.expectOne('/api/v1/company/applications/a-1/pull-requests/7/builds');
    expect(request.request.method).toBe('POST');
    request.flush(build({ status: 'queued' }));
    await settle();
    http.expectOne('/api/v1/company/applications/a-1/builds').flush([build()]);
    await settle();
    http.expectOne('/api/v1/company/applications/a-1/versions').flush(VERSIONS);
    await settle();
    http.expectOne('/api/v1/company/applications/a-1/pull-requests').flush([PULL_REQUEST]);
    await render(fixture);

    expect(text(fixture)).toContain('0.1.0-dev.pr7.1 is being built from pull request #7.');
    expect(button(fixture, 'Start release 1.4.0')).toBeUndefined();
    // The latest commit has an image now, so building it again is pointless.
    expect(button(fixture, 'Build a development image of pull request 7')?.disabled).toBe(true);
  });

  it('says when a pull request has commits newer than its image', async () => {
    const fixture = await open(['feature-images:build'], {
      builds: [build({ commit: 'e'.repeat(40) })],
      pullRequests: [PULL_REQUEST],
    });

    expect(text(fixture)).toContain('Newer commits are waiting to be built.');
    expect(button(fixture, 'Build a development image of pull request 7')?.disabled).toBe(false);
  });

  it('starts releases and hotfixes, and builds new candidates', async () => {
    const idle = { ...VERSIONS, lines: [] };
    const fixture = await open(['releases:start', 'feature-images:build'], { versions: idle });
    const act = async (label: string, url: string, answer: Build, body: object | undefined, after: object) => {
      button(fixture, label)!.click();
      const request = http.expectOne(url);
      if (body !== undefined) {
        expect(request.request.body).toEqual(body);
      }
      request.flush(answer);
      await settle();
      http.expectOne('/api/v1/company/applications/a-1/builds').flush([answer]);
      await settle();
      http.expectOne('/api/v1/company/applications/a-1/versions').flush(after);
      await settle();
      http.expectOne('/api/v1/company/applications/a-1/pull-requests').flush([]);
      await render(fixture);
    };
    const candidate = (version: string, branch: string, kind: Build['kind']) =>
      build({ id: version, kind, version, branch, pullRequest: null, status: 'succeeded' });

    await act(
      'Start major release 2.0.0',
      '/api/v1/company/applications/a-1/releases',
      candidate('2.0.0-rc.1', 'release/2.0.0', 'release-candidate'),
      { bump: 'major' },
      idle,
    );
    expect(text(fixture)).toContain('Release started on release/2.0.0. Its first candidate, 2.0.0-rc.1, is being built.');

    await act(
      'Start hotfix 1.3.1',
      '/api/v1/company/applications/a-1/hotfixes',
      candidate('1.3.1-hotfix.1', 'hotfix/1.3.1', 'hotfix-candidate'),
      undefined,
      idle,
    );
    expect(text(fixture)).toContain('Hotfix started on hotfix/1.3.1. Its first candidate, 1.3.1-hotfix.1, is being built.');

    await act(
      'Start release 1.4.0',
      '/api/v1/company/applications/a-1/releases',
      candidate('1.4.0-rc.1', 'release/1.4.0', 'release-candidate'),
      { bump: 'minor' },
      VERSIONS,
    );
    // With a release in progress, another can't start, so it isn't offered.
    expect(button(fixture, 'Start release 1.4.0')).toBeUndefined();
    expect(button(fixture, 'Start major release 2.0.0')).toBeUndefined();
    expect(text(fixture)).toContain('Only one release runs at a time. Merge release/1.4.0 into main before starting another.');
    expect(button(fixture, 'Start hotfix 1.3.1')).toBeDefined();

    await act(
      'Build a new candidate from release/1.4.0',
      '/api/v1/company/applications/a-1/candidates',
      candidate('1.4.0-rc.2', 'release/1.4.0', 'release-candidate'),
      { branch: 'release/1.4.0' },
      VERSIONS,
    );
    expect(text(fixture)).toContain('1.4.0-rc.2 is being built from release/1.4.0.');
  });

  it('offers no second hotfix while one is in progress', async () => {
    const fixture = await open(['releases:start'], {
      versions: {
        ...VERSIONS,
        lines: [{ kind: 'hotfix', branch: 'hotfix/1.3.1', version: '1.3.1', latestCandidate: null }],
      },
    });

    expect(button(fixture, 'Start hotfix 1.3.1')).toBeUndefined();
    expect(button(fixture, 'Start release 1.4.0')).toBeDefined();
    expect(text(fixture)).toContain('Only one hotfix runs at a time. Merge hotfix/1.3.1 into main before starting another.');
  });

  it('explains why a release could not start', async () => {
    const fixture = await open(['releases:start'], { versions: { ...VERSIONS, lines: [] } });

    button(fixture, 'Start release 1.4.0')!.click();
    http
      .expectOne('/api/v1/company/applications/a-1/releases')
      .flush(
        { status: 409, detail: 'Release 1.4.0 is already in progress on release/1.4.0. Finish it first.' },
        { status: 409, statusText: 'Conflict' },
      );
    await render(fixture);

    expect(text(fixture)).toContain('Release 1.4.0 is already in progress on release/1.4.0. Finish it first.');
  });

  it('offers no hotfix before the first release', async () => {
    const fixture = await open(['releases:start'], {
      versions: { onMain: null, published: null, next: { minor: '0.1.0', major: '1.0.0', hotfix: null }, lines: [] },
      builds: [],
    });

    expect(text(fixture)).toContain('Nothing is released yet.');
    expect(button(fixture, 'Start release 0.1.0')).toBeDefined();
    expect(text(fixture)).not.toContain('Start hotfix');
    expect(text(fixture)).toContain('No builds yet.');
  });

  it('says when a merged release is not published yet', async () => {
    const fixture = await open(['dashboards:view'], {
      versions: { ...VERSIONS, onMain: '1.4.0', published: '1.3.0', lines: [] },
    });

    expect(text(fixture)).toContain("Main has 1.4.0, but its image isn't published yet. The latest published release is 1.3.0.");
  });

  it('still works when the Git service cannot list pull requests', async () => {
    const fixture = await open(['feature-images:build'], { pullRequests: 'fail' });

    expect(text(fixture)).toContain('The Git service could not be reached.');
    expect(text(fixture)).toContain('0.1.0-dev.pr7.1');
  });

  it('explains how to check signatures', async () => {
    const fixture = await open(['dashboards:view']);

    expect(text(fixture)).toContain(`Key fingerprint: ${KEY.fingerprint}`);
    expect(element(fixture).querySelector('details pre')?.textContent).toContain('BEGIN PUBLIC KEY');
    expect(text(fixture)).toContain('cosign verify --key dreamdevops-images.pub --insecure-ignore-tlog=true <image>@<digest>');
  });

  it('opens the application from the address, and switches between applications', async () => {
    const fixture = await open(['dashboards:view'], { query: { application: 'a-2' } });
    const select = element(fixture).querySelector<HTMLSelectElement>('select')!;
    expect(select.value).toBe('a-2');

    select.value = 'a-1';
    select.dispatchEvent(new Event('change'));
    await answerApplication('a-1', { builds: [build({ version: '9.9.9-dev.pr1.1' })] });
    await render(fixture);

    expect(text(fixture)).toContain('9.9.9-dev.pr1.1');
  });

  it('leaves out applications whose repository is not ready', async () => {
    setUp(['dashboards:view']);
    const fixture = TestBed.createComponent(Builds);
    fixture.detectChanges();
    await settle();
    http.expectOne((candidate) => candidate.url === '/api/v1/company/applications').flush([BILLING]);
    http.expectOne('/api/v1/company/repositories').flush([repository('a-1', 'creating')]);
    await settle();
    http.expectOne('/api/v1/company/image-signing-key').flush(KEY);
    await render(fixture);

    expect(text(fixture)).toContain('No application has a repository yet.');
  });
});
