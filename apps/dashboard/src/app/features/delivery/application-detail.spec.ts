import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describeEvent } from '../../core/events';
import { SessionService } from '../../core/session.service';
import { settle } from '../../testing';
import { ApplicationDetail } from './application-detail';

const APP = {
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
const REPOSITORY = {
  applicationId: 'a-1',
  status: 'ready',
  fullName: 'acme/billing',
  url: 'http://git.test/acme/billing',
  blueprint: { key: 'node-service', version: '1.0.0' },
  lastError: null,
};
const build = (overrides: object) => ({
  id: 'b-1',
  applicationId: 'a-1',
  kind: 'feature',
  branch: 'feature/login',
  commit: 'a'.repeat(40),
  tag: 'feature-login-aaaaaaa',
  version: null,
  releaseId: null,
  status: 'succeeded',
  failureReason: null,
  reports: { scan: { critical: 0, high: 2, medium: 1, low: 0, unknown: 0 } },
  progress: [],
  imageRef: 'localhost:3000/acme/billing:feature-login-aaaaaaa',
  digest: `sha256:${'d'.repeat(64)}`,
  signedWith: 'test',
  createdAt: '2026-11-02T10:00:00Z',
  finishedAt: '2026-11-02T10:05:00Z',
  ...overrides,
});
const PUBLISHED = {
  id: 'r-1',
  kind: 'release',
  version: '1.0.0',
  branch: 'release/1.0.0',
  status: 'published',
  candidates: [{ number: 1, commit: 'c'.repeat(40), tag: 'v1.0.0-rc.1', buildId: 'b-2', buildStatus: 'succeeded' }],
  mergeBackPullRequest: 4,
  finalBuildId: 'b-3',
  finalBuildStatus: 'succeeded',
  createdAt: '2026-11-03T10:00:00Z',
  mergedAt: '2026-11-03T11:00:00Z',
  publishedAt: '2026-11-03T11:10:00Z',
};

describe('ApplicationDetail', () => {
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
    [...element(fixture).querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)!;
  const render = async (fixture: ComponentFixture<unknown>) => {
    await settle();
    await fixture.whenStable();
  };
  const answerRefresh = async (data: { builds?: object[]; versions?: object[]; releases?: object[] } = {}) => {
    await settle();
    http.expectOne('/api/v1/company/applications/a-1/builds').flush(data.builds ?? []);
    http.expectOne('/api/v1/company/applications/a-1/versions').flush(data.versions ?? []);
    http.expectOne('/api/v1/company/applications/a-1/releases').flush({
      releases: data.releases ?? [],
      suggestions: { release: '1.1.0', hotfix: '1.0.1' },
    });
  };
  const open = async (
    permissions: string[],
    data: {
      builds?: object[];
      versions?: object[];
      releases?: object[];
      branches?: string[];
      environments?: object[];
      deployments?: object[];
    } = {},
  ) => {
    setUp(permissions);
    const fixture = TestBed.createComponent(ApplicationDetail);
    fixture.componentRef.setInput('id', 'a-1');
    fixture.detectChanges();
    await settle();
    http.expectOne('/api/v1/company/applications/a-1').flush(APP);
    http.expectOne('/api/v1/company/repositories').flush([REPOSITORY]);
    if (permissions.includes('feature-images:build')) {
      await settle();
      http.expectOne('/api/v1/company/applications/a-1/branches').flush(data.branches ?? ['develop', 'feature/login', 'main']);
    }
    await answerRefresh(data);
    // The deployments panel loads the environments to deploy to, then the deployments.
    await settle();
    http.expectOne((request) => request.url === '/api/v1/company/environments').flush(data.environments ?? []);
    await settle();
    http.expectOne((request) => request.url === '/api/v1/company/deployments').flush(data.deployments ?? []);
    await render(fixture);
    return fixture;
  };

  it('shows the repository and the version list, with how each image is signed', async () => {
    const fixture = await open(['dashboards:view'], { versions: [build({}), build({ id: 'b-3', kind: 'final', tag: '1.0.0', signedWith: 'release' })] });

    const link = element(fixture).querySelector<HTMLAnchorElement>('a[href="http://git.test/acme/billing"]')!;
    expect(link.textContent).toBe('acme/billing');
    expect(text(fixture)).toContain('localhost:3000/acme/billing:feature-login-aaaaaaa');
    expect(text(fixture)).toContain('Test key');
    expect(text(fixture)).toContain('Release key');
    expect(text(fixture)).toContain('0 critical, 2 high, 1 medium');
    expect(element(fixture).querySelector<HTMLAnchorElement>('a[href="/api/v1/company/builds/b-1/sbom"]')).not.toBeNull();
  });

  it('shows members without the permissions no build or release controls', async () => {
    const fixture = await open(['dashboards:view']);

    expect(text(fixture)).not.toContain('Build a test image');
    expect(button(fixture, 'Start')).toBeUndefined();
  });

  it('builds a feature image from a chosen feature branch only', async () => {
    const fixture = await open(['feature-images:build']);
    const options = [...element(fixture).querySelectorAll<HTMLOptionElement>('select[formcontrolname="branch"] option')];
    expect(options.map((option) => option.value)).toEqual(['feature/login']);

    button(fixture, 'Build test image').click();
    const request = http.expectOne('/api/v1/company/applications/a-1/feature-builds');
    expect(request.request.body).toEqual({ branch: 'feature/login' });
    request.flush(build({ status: 'queued' }));
    await answerRefresh({ builds: [build({ status: 'running' })] });
    await render(fixture);

    expect(text(fixture)).toContain('Building feature-login-aaaaaaa.');
    expect(text(fixture)).toContain('Building');
    fixture.destroy();
  });

  it('shows where each step of a running build stands', async () => {
    const fixture = await open(['dashboards:view'], {
      builds: [
        build({
          status: 'running',
          reports: { secrets: { found: 0 }, tests: { passed: true, log: '' } },
          progress: [
            { job: 'secrets', state: 'passed', startedAt: '2026-11-02T10:00:10Z' },
            { job: 'test', state: 'passed', startedAt: '2026-11-02T10:00:10Z' },
            { job: 'image', state: 'running', startedAt: '2026-11-02T10:01:00Z' },
            { job: 'scan', state: 'waiting', startedAt: null },
            { job: 'sbom', state: 'waiting', startedAt: null },
          ],
        }),
      ],
    });
    const steps = [...element(fixture).querySelectorAll<HTMLElement>('.step')].map((step) => [
      step.dataset['state'],
      step.textContent?.replace(/\s+/g, ' ').trim(),
    ]);

    expect(steps).toEqual([
      ['passed', '✓Secret scan: done, none found'],
      ['passed', '✓Tests: done'],
      ['running', '◐Image: in progress'],
      ['waiting', '○Vulnerability scan: waiting'],
      ['waiting', '○SBOM: waiting'],
    ]);
    fixture.destroy();
  });

  it('explains a failed build, with the end of the test output', async () => {
    const fixture = await open(['dashboards:view'], {
      builds: [build({ status: 'failed', failureReason: 'The tests failed.', reports: { tests: { passed: false, log: 'expected 2 to be 3' } } })],
    });

    expect(text(fixture)).toContain('The tests failed.');
    expect(element(fixture).querySelector('pre.log')?.textContent).toContain('expected 2 to be 3');
  });

  it('starts a release with the suggested version', async () => {
    const fixture = await open(['releases:start'], { releases: [PUBLISHED] });
    expect(element(fixture).querySelector<HTMLInputElement>('input[formcontrolname="version"]')!.value).toBe('1.1.0');

    button(fixture, 'Start').click();
    const request = http.expectOne((candidate) => candidate.method === 'POST' && candidate.url.endsWith('/releases'));
    expect(request.request.body).toEqual({ kind: 'release', version: '1.1.0' });
    request.flush({ id: 'r-2' });
    await answerRefresh({ releases: [PUBLISHED] });
    await render(fixture);

    expect(text(fixture)).toContain('The release 1.1.0 started.');
  });

  it('shows a release with its candidates, final image and merge back', async () => {
    const fixture = await open(['dashboards:view'], { releases: [PUBLISHED] });

    expect(text(fixture)).toContain('Release 1.0.0');
    expect(text(fixture)).toContain('Published');
    expect(text(fixture)).toContain('v1.0.0-rc.1');
    expect(element(fixture).querySelector<HTMLAnchorElement>('a[href="http://git.test/acme/billing/pulls/4"]')).not.toBeNull();
  });

  it('builds a failed final image again', async () => {
    const merged = { ...PUBLISHED, status: 'merged', finalBuildStatus: 'failed', publishedAt: null };
    const fixture = await open(['releases:start'], { releases: [merged] });

    button(fixture, 'Build it again').click();
    http.expectOne('/api/v1/company/releases/r-1/final-build').flush(null);
    await answerRefresh({ releases: [{ ...merged, finalBuildStatus: 'running' }] });
    await render(fixture);

    expect(text(fixture)).toContain('Building the final image of 1.0.0 again.');
    fixture.destroy();
  });

  it('describes the new events in the audit log', () => {
    setUp([]);
    expect(describeEvent('BuildSucceeded', { tag: '1.0.0' })).toBe('Built, scanned and signed the image 1.0.0');
    expect(describeEvent('PullRequestMerged', { number: 3, head: 'release/1.0.0', base: 'main' })).toBe(
      'Merged pull request #3 from release/1.0.0 into main',
    );
    expect(describeEvent('ReleasePublished', { version: '1.0.0' })).toBe('Published version 1.0.0');
  });
});
