import type { ApplicationDirectory } from '@dreamdevops/contracts/catalog/services';
import type { RepositoryLookup, RepositorySpec } from '@dreamdevops/contracts/source-governance/services';
import { parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { beforeEach, describe, expect, it } from 'vitest';
import { Builds } from '../src/builds/application/builds.ts';
import { SigningKeys } from '../src/builds/application/signing-keys.ts';
import { FakeImageRegistry, FakePipelineHost, FakeSourceHost, InMemoryBuildsStore, RecordingLogger } from './fakes.ts';

const companyId = parseCompanyId('00000000-0000-4000-8000-00000000c0de');
const buildId = '00000000-0000-4000-8000-0000000000b1';
const spec: RepositorySpec = { organization: 'acme', name: 'billing', applicationId: '00000000-0000-4000-8000-0000000000a1' };
const DOCKERFILE = 'FROM node:24-alpine@sha256:' + 'a'.repeat(64) + '\nUSER node\n';
const START_TIMEOUT_MINUTES = 15;

let store: InMemoryBuildsStore;
let pipelines: FakePipelineHost;
let logger: RecordingLogger;
let builds: Builds;

beforeEach(async () => {
  store = new InMemoryBuildsStore();
  pipelines = new FakePipelineHost();
  logger = new RecordingLogger();
  const source = new FakeSourceHost();
  await source.ensureRepository(spec);
  await source.commitInitialFiles(spec, [
    { path: 'Dockerfile', content: Buffer.from(DOCKERFILE) },
    { path: '.dockerignore', content: Buffer.from('node_modules\n') },
  ]);
  const repositories = { locate: async () => spec } as unknown as RepositoryLookup;
  builds = new Builds(
    store,
    {} as ApplicationDirectory,
    repositories,
    source,
    new FakeImageRegistry(),
    pipelines,
    new SigningKeys('a signing key secret that is long enough'),
    {
      toolsApiUrl: 'http://host.docker.internal:4000',
      workDir: '/tmp/dreamdevops-build-start-test',
      timeoutMinutes: 60,
      startTimeoutMinutes: START_TIMEOUT_MINUTES,
      pipelines: { 'build.yaml': 'name: image', 'check.yaml': 'name: check' },
    },
    logger,
  );
  store.addQueued(
    { id: buildId, applicationId: spec.applicationId, kind: 'feature', branch: 'feature/login', commit: 'c'.repeat(40), tag: 'feature-login', version: null, releaseId: null },
    companyId,
  );
});

const inCompany = <T>(work: () => Promise<T>) => runWithCompany(companyId, work);
const build = () => store.builds.get(buildId)!;

describe("a build's start", () => {
  it('checks the Dockerfile, then starts the pipeline with a one-time token and where jobs reach the platform', async () => {
    await inCompany(() => builds.start(buildId, { last: false }));

    expect(build()).toMatchObject({ status: 'running', failureReason: null });
    expect(build().reports.dockerfile?.checks.every((check) => check.outcome === 'passed')).toBe(true);
    expect(pipelines.runs).toEqual([
      {
        organization: 'acme',
        workflow: 'build.yaml',
        inputs: { build: buildId, token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), api: 'http://host.docker.internal:4000' },
      },
    ]);
    expect(build().tokenHash).not.toContain(pipelines.tokenOf(buildId));
  });

  it('throws while tries remain, so the start runs again, and the build keeps waiting meanwhile', async () => {
    pipelines.setupFailures = 1;

    await expect(inCompany(() => builds.start(buildId, { last: false }))).rejects.toThrow('could not add the pipeline');
    expect(build()).toMatchObject({ status: 'queued', failureReason: null });

    await inCompany(() => builds.start(buildId, { last: false }));
    expect(build().status).toBe('running');
  });

  it('fails the build with the reason on the last try, rather than leaving it waiting for a pipeline that never comes', async () => {
    pipelines.setupFailures = 1;

    await inCompany(() => builds.start(buildId, { last: true }));

    expect(build()).toMatchObject({
      status: 'failed',
      failureReason: 'The pipeline could not be started: The Git service could not add the pipeline (status 503).',
    });
    expect(store.events.map((event) => event.eventType)).toEqual(['BuildFailed']);
    expect(logger.lines).toEqual([
      `error: The pipeline of build ${buildId} could not be started: The Git service could not add the pipeline (status 503).`,
    ]);
    expect(pipelines.runs).toEqual([]);
  });

  it('fails the build at once when its run is refused, since another try would find it taken', async () => {
    pipelines.runFailing = true;

    await inCompany(() => builds.start(buildId, { last: false }));

    expect(build()).toMatchObject({
      status: 'failed',
      failureReason: 'The pipeline could not be started: The Git service could not start the pipeline (status 500).',
      tokenHash: null,
    });
  });

  it('does nothing for a build that is no longer waiting, such as when its event comes twice', async () => {
    await inCompany(() => builds.start(buildId, { last: false }));
    await inCompany(() => builds.start(buildId, { last: true }));

    expect(pipelines.runs).toHaveLength(1);
    expect(build().status).toBe('running');
  });
});

describe('the sweep, for pipelines whose jobs never say anything', () => {
  const later = (minutes: number) => {
    store.now = new Date(store.now.getTime() + minutes * 60_000);
  };

  it(`fails the build once ${START_TIMEOUT_MINUTES} minutes pass, and tells operators what to check`, async () => {
    await inCompany(() => builds.start(buildId, { last: false }));

    later(START_TIMEOUT_MINUTES - 1);
    await builds.expireStale();
    expect(build().status).toBe('running');

    later(2);
    await builds.expireStale();
    expect(build()).toMatchObject({
      status: 'failed',
      failureReason:
        "No pipeline job started within 15 minutes: the runners may all be busy or offline, or their jobs can't reach the platform. Try the build again later.",
    });
    expect(logger.lines).toEqual([
      `warn: No job of build ${buildId}'s pipeline reported within 15 minutes, so the build failed. ` +
        'Check that the CI runners are online and free, and that their jobs can reach the API at http://host.docker.internal:4000.',
    ]);
  });

  it('leaves a build whose jobs run, however long they take, up to the build timeout', async () => {
    await inCompany(() => builds.start(buildId, { last: false }));
    await inCompany(() => store.transaction((session) => session.markJobStarted(buildId, 'secrets')));

    later(START_TIMEOUT_MINUTES + 30);
    await builds.expireStale();
    expect(build().status).toBe('running');

    later(30);
    await builds.expireStale();
    expect(build()).toMatchObject({ status: 'failed', failureReason: "The build didn't finish within 60 minutes." });
  });
});
