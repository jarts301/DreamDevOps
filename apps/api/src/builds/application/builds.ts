import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { BuildFailed, BuildRequested, BuildSucceeded, FeatureImageDeleted } from '@dreamdevops/contracts/builds/events';
import type { BuildView, PublicSigningKey, SbomDocument } from '@dreamdevops/contracts/builds/http';
import type { BuildRequest, BuildRequests, DeployableImages } from '@dreamdevops/contracts/builds/services';
import {
  type Attempt,
  type CompanyId,
  currentCompanyId,
  describeError,
  type Logger,
  parseCompanyId,
  runWithCompany,
} from '@dreamdevops/shared-kernel';
import { type ApplicationDirectory } from '@dreamdevops/contracts/catalog/services';
import type { Principal } from '@dreamdevops/contracts/identity-access/access';
import {
  type RepositoryGit,
  type RepositoryLookup,
  type RepositorySpec,
  TESTS_CHECK,
} from '@dreamdevops/contracts/source-governance/services';
import {
  buildProgress,
  type BuildStatus,
  checkTag,
  countComponents,
  evaluate,
  featureTag,
  PIPELINE_JOBS,
  pipelineHasReported,
  type PipelineJob,
  type Reports,
  signingPurposeFor,
  summarizeScan,
  summarizeSecrets,
} from '../domain/build.ts';
import { signaturePayload, signatureTag, signPayload, verifyPayload } from '../domain/cosign.ts';
import { BuildError } from '../domain/errors.ts';
import { checkImage, checkRepositoryFiles, checkStoredSignature, failedChecksReason, type PlatformChecks } from '../domain/image-rules.ts';
import { failed } from '../domain/checks.ts';
import type { BuildsSession, BuildsStore, ImageRegistry, PipelineHost, StoredBuild } from './ports.ts';
import type { SigningKeys } from './signing-keys.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_COMPANY = parseCompanyId('00000000-0000-0000-0000-000000000000');
const MAX_IMAGE_BYTES = 4 * 1024 * 1024 * 1024;
/** Parts are 16 MiB before base64, which makes them about a third larger. */
const MAX_PART_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_PARTS = 256;
/** The files a build's pipeline uploads: its image's parts, parts being written, and the joined image. */
const UPLOAD_FILE = /^[0-9a-f-]{36}\.(?:tar|part-\d+(?:\.[0-9a-f-]{36}\.partial)?)$/;
/** How long after the build timeout its uploads are kept, in case its last steps are still finishing. */
const ABANDONED_UPLOAD_GRACE_MINUTES = 60;
const MAX_REPORT_BYTES: Readonly<Record<ReportKind, number>> = {
  secrets: 5 * 1024 * 1024,
  tests: 256 * 1024,
  scan: 50 * 1024 * 1024,
  sbom: 100 * 1024 * 1024,
  failure: 4 * 1024,
  'build-log': 64 * 1024,
};

const JOB_NAMES: Readonly<Record<string, string>> = {
  secrets: 'secret scan',
  test: 'tests',
  image: 'image build',
  scan: 'vulnerability scan',
  sbom: 'SBOM',
};

/** Why a pipeline job may have stopped, and what to do, for people reading the build. */
const JOB_ADVICE: Readonly<Record<string, string>> = {
  image: "The Dockerfile didn't build. The end of the build's output is in the image build log.",
};
const DEFAULT_JOB_ADVICE = "It stopped before it reported, such as when a tool couldn't be downloaded. Try the build again.";

export type ReportKind = 'secrets' | 'tests' | 'scan' | 'sbom' | 'failure' | 'build-log';

// What a build is asked for is Builds' published language, kept in its contracts.
export type { BuildRequest } from '@dreamdevops/contracts/builds/services';

export interface BuildsOptions {
  /** Where pipeline jobs reach the API. */
  readonly toolsApiUrl: string;
  readonly workDir: string;
  /** Builds that haven't finished by then, from when they were asked for, fail. */
  readonly timeoutMinutes: number;
  /** Builds none of whose pipeline's jobs has said anything by then, from when it started, fail. */
  readonly startTimeoutMinutes: number;
  /** The platform's workflows by file name, kept in each company's pipeline repository. */
  readonly pipelines: Readonly<Record<'build.yaml' | 'check.yaml', string>>;
}

/**
 * Builds images in the platform's pipeline, and keeps the list of versions. The platform,
 * not the pipeline, pushes and signs images, and decides from the jobs' reports whether a
 * build passed.
 */
export class Builds implements BuildRequests, DeployableImages {
  readonly #store: BuildsStore;
  readonly #catalog: ApplicationDirectory;
  readonly #repositories: RepositoryLookup;
  readonly #source: RepositoryGit;
  readonly #registry: ImageRegistry;
  readonly #pipelines: PipelineHost;
  readonly #keys: SigningKeys;
  readonly #options: BuildsOptions;
  readonly #logger: Logger;

  constructor(
    store: BuildsStore,
    catalog: ApplicationDirectory,
    repositories: RepositoryLookup,
    source: RepositoryGit,
    registry: ImageRegistry,
    pipelines: PipelineHost,
    keys: SigningKeys,
    options: BuildsOptions,
    logger: Logger,
  ) {
    this.#store = store;
    this.#catalog = catalog;
    this.#repositories = repositories;
    this.#source = source;
    this.#registry = registry;
    this.#pipelines = pipelines;
    this.#keys = keys;
    this.#options = options;
    this.#logger = logger;
  }

  /** The branches of an application's repository, to build feature images from. */
  branches(applicationIdValue: unknown): Promise<string[]> {
    return this.#repositories.branches(applicationIdValue);
  }

  /** A developer builds a test image from the newest commit of a feature branch. */
  async requestFeatureBuild(actor: Principal, applicationIdValue: unknown, branchValue: unknown): Promise<BuildView> {
    const application = await this.#catalog.get(applicationIdValue);
    if (application.status === 'archived') {
      throw new BuildError('conflict', 'Restore the application first.');
    }
    if (typeof branchValue !== 'string' || !/^feature\/[A-Za-z0-9._/-]{1,200}$/.test(branchValue)) {
      throw new BuildError('invalid', 'Choose a feature/* branch.');
    }
    const spec = await this.#repositories.locate(application.id);
    if (spec === null) {
      throw new BuildError('conflict', "The application's repository isn't ready yet.");
    }
    const commit = await this.#source.branchHead(spec, branchValue);
    if (commit === null) {
      throw new BuildError('not-found', 'This branch does not exist.');
    }
    const id = await this.request({
      applicationId: application.id,
      kind: 'feature',
      branch: branchValue,
      commit,
      tag: featureTag(branchValue, commit),
      version: null,
      releaseId: null,
      actorId: actor.userId,
    });
    return this.get(id);
  }

  /**
   * Checks the newest commit of a pull request with the platform's tests and secret scan,
   * and reports the result as the status the branch rules require. A commit already
   * checked isn't checked again.
   */
  async requestCheck(applicationId: string, branch: string, commit: string): Promise<void> {
    const spec = await this.#repositories.locate(applicationId);
    if (spec === null) {
      return;
    }
    await this.#source.setCommitStatus(spec, commit, {
      context: TESTS_CHECK,
      state: 'pending',
      description: 'The platform is running the tests and the secret scan.',
    });
    const id = await this.request({
      applicationId,
      kind: 'check',
      branch,
      commit,
      tag: checkTag(commit),
      version: null,
      releaseId: null,
      actorId: null,
    });
    // A commit checked before keeps its result, which is reported again.
    const build = await this.get(id);
    if (build.status === 'succeeded' || build.status === 'failed') {
      await this.reportCheck({ kind: 'check', applicationId, commit, reason: build.failureReason ?? undefined }, build.status === 'succeeded');
    }
  }

  /** Reports a finished check on its commit. */
  async reportCheck(
    build: { readonly kind: string; readonly applicationId: string; readonly commit: string; readonly reason?: string | undefined },
    succeeded: boolean,
  ): Promise<void> {
    if (build.kind !== 'check') {
      return;
    }
    const spec = await this.#repositories.locate(build.applicationId);
    if (spec === null) {
      return;
    }
    await this.#source.setCommitStatus(spec, build.commit, {
      context: TESTS_CHECK,
      state: succeeded ? 'success' : 'failure',
      description: succeeded ? 'The tests passed and no secrets were found.' : (build.reason ?? 'The check failed.'),
    });
  }

  /**
   * Asks for a build. A build of the same image that's still running or has succeeded is
   * reused, so repeated events don't build twice.
   */
  request(input: BuildRequest): Promise<string> {
    return this.#store.transaction(async (session) => {
      await session.lockApplication(input.applicationId);
      const reusable = await session.reusableBuild(input.applicationId, input.tag);
      if (reusable !== null) {
        return reusable;
      }
      const id = randomUUID();
      await session.add({
        id,
        applicationId: input.applicationId,
        kind: input.kind,
        branch: input.branch,
        commit: input.commit,
        tag: input.tag,
        version: input.version,
        releaseId: input.releaseId,
        signingKey: input.kind === 'check' ? null : signingPurposeFor(input.kind),
        requestedBy: input.actorId,
      });
      await session.record([
        BuildRequested.create({
          companyId: currentCompanyId(),
          actorId: input.actorId,
          payload: {
            buildId: id,
            applicationId: input.applicationId,
            kind: input.kind,
            branch: input.branch,
            commit: input.commit,
            tag: input.tag,
            version: input.version,
          },
        }),
      ]);
      return id;
    });
  }

  /**
   * Starts the pipeline for a requested build. Runs in the build's company.
   *
   * Until its pipeline runs, a build waits, and nothing else moves it on. So a failure
   * before then, such as the Git service being down, is thrown for the event to come again,
   * and the last try fails the build with the reason instead, so it never waits for a
   * pipeline that isn't coming.
   */
  async start(buildId: string, attempt: Attempt = { last: true }): Promise<void> {
    let ready: { readonly build: StoredBuild; readonly spec: RepositorySpec } | null;
    try {
      ready = await this.#prepareStart(buildId);
    } catch (error) {
      if (!attempt.last) {
        throw error;
      }
      await this.#cannotStart(buildId, error);
      return;
    }
    if (ready === null) {
      return;
    }
    const { build, spec } = ready;
    const token = randomBytes(32).toString('base64url');
    // Only the start that moves the build from queued to running starts its pipeline. An
    // event can arrive twice, and then the other one finds it taken and does nothing.
    const claimed = await this.#store.transaction((session) =>
      session.startRunning(buildId, hashToken(token), this.#options.timeoutMinutes),
    );
    if (!claimed) {
      return;
    }
    // It runs now, so a later try would find it taken: a run that doesn't start fails it at once.
    try {
      await this.#pipelines.run(spec.organization, build.kind === 'check' ? 'check.yaml' : 'build.yaml', {
        build: buildId,
        token,
        api: this.#options.toolsApiUrl,
      });
    } catch (error) {
      await this.#cannotStart(buildId, error);
    }
  }

  /**
   * Checks the Dockerfile, and brings the company's pipeline up to date. Null when there's
   * nothing to start: the build isn't waiting any more, or it failed a platform rule.
   */
  async #prepareStart(buildId: string): Promise<{ readonly build: StoredBuild; readonly spec: RepositorySpec } | null> {
    const build = await this.#store.transaction((session) => session.find(buildId));
    if (build === null || build.status !== 'queued') {
      return null;
    }
    const spec = await this.#repositories.locate(build.applicationId);
    if (spec === null) {
      await this.#fail(buildId, "The application's repository isn't ready.");
      return null;
    }
    // The platform checks the Dockerfile itself, at the exact commit, before any job runs.
    const [dockerfile, dockerignore] = await Promise.all([
      this.#source.readFile(spec, build.commit, 'Dockerfile'),
      this.#source.readFile(spec, build.commit, '.dockerignore'),
    ]);
    const rules = checkRepositoryFiles(dockerfile?.toString('utf8') ?? null, dockerignore !== null);
    await this.#store.transaction((session) => session.addReports(buildId, { dockerfile: rules }));
    const broken = failedChecksReason('The Dockerfile breaks a platform rule', rules.checks);
    if (broken !== null) {
      await this.#fail(buildId, broken);
      return null;
    }
    await this.#pipelines.ensurePipeline(spec.organization, this.#options.pipelines);
    return { build, spec };
  }

  /** Fails a build whose pipeline couldn't be started, with why, so people see it and can try again. */
  async #cannotStart(buildId: string, error: unknown): Promise<void> {
    const reason = describeError(error);
    this.#logger.error(`The pipeline of build ${buildId} could not be started: ${reason}`);
    await this.#fail(buildId, `The pipeline could not be started: ${reason}`);
  }

  // ---- Reads

  list(applicationIdValue: unknown): Promise<BuildView[]> {
    const applicationId = parseId(applicationIdValue, 'application');
    return this.#store.transaction(async (session) => (await session.list(applicationId, 100)).map(toView));
  }

  /** The status of each build, for other modules, such as releases. Unknown IDs are left out. */
  async statuses(buildIds: readonly string[]): Promise<Map<string, BuildStatus>> {
    if (buildIds.length === 0) {
      return new Map();
    }
    const builds = await this.#store.transaction((session) => session.many(buildIds));
    return new Map(builds.map((build) => [build.id, build.status]));
  }

  /** Several builds by ID, for other modules, such as deployments. Unknown IDs are left out. */
  async many(buildIds: readonly string[]): Promise<Map<string, BuildView>> {
    if (buildIds.length === 0) {
      return new Map();
    }
    const builds = await this.#store.transaction((session) => session.many(buildIds));
    return new Map(builds.map((build) => [build.id, toView(build)]));
  }

  /**
   * Reads a build's signature back from the registry and checks it with the company's key
   * for the build's kind, as a target would. For runtimes the platform drives itself, such
   * as This machine, which check before they pull.
   */
  async checkSignature(buildId: string): Promise<PlatformChecks> {
    const build = await this.#store.transaction((session) => session.find(buildId));
    if (build === null || build.digest === null || build.status !== 'succeeded') {
      return { checks: [failed('The image is signed', 'This version has no signed image.')], facts: [] };
    }
    const spec = await this.#repositories.locate(build.applicationId);
    const application = await this.#catalog.get(build.applicationId);
    if (spec === null) {
      return { checks: [failed('The image is signed', "The application's repository isn't ready.")], facts: [] };
    }
    const repository = `${spec.organization}/${application.slug}`;
    const purpose = signingPurposeFor(build.kind);
    const publicKey = await this.#store.transaction((session) => this.#keys.publicKey(session, purpose));
    return checkStoredSignature(
      signaturePayload(`${this.#registry.imageHost}/${repository}`, build.digest),
      await this.#registry.readSignature(repository, build.digest),
      (payload, signature) => verifyPayload(publicKey, payload, signature),
      `cosign verify --key ${purpose}.pub --insecure-ignore-tlog=true ${this.#registry.imageHost}/${repository}@${build.digest}`,
    );
  }

  /** The deployable versions: signed images that passed every check. */
  versions(applicationIdValue: unknown): Promise<BuildView[]> {
    const applicationId = parseId(applicationIdValue, 'application');
    return this.#store.transaction(async (session) => (await session.versions(applicationId, 200)).map(toView));
  }

  async get(buildIdValue: unknown): Promise<BuildView> {
    const buildId = parseId(buildIdValue, 'build');
    const build = await this.#store.transaction((session) => session.find(buildId));
    if (build === null) {
      throw new BuildError('not-found', 'This build does not exist.');
    }
    return toView(build);
  }

  async sbom(buildIdValue: unknown): Promise<SbomDocument> {
    const buildId = parseId(buildIdValue, 'build');
    const document = await this.#store.transaction((session) => session.sbom(buildId));
    if (document === null) {
      throw new BuildError('not-found', 'This build has no SBOM.');
    }
    return document;
  }

  publicKeys(): Promise<PublicSigningKey[]> {
    return this.#store.transaction((session) => this.#keys.publicKeys(session));
  }

  // ---- Pipeline jobs. They have no session; each call proves itself with the build's token.

  async source(buildIdValue: unknown, token: string | undefined): Promise<ReadableStream<Uint8Array>> {
    const { companyId, build } = await this.#authorize(buildIdValue, token);
    return runWithCompany(companyId, async () => {
      const spec = await this.#repositories.locate(build.applicationId);
      if (spec === null) {
        throw new BuildError('not-found', "The application's repository isn't ready.");
      }
      return this.#source.downloadArchive(spec, build.commit);
    });
  }

  async report(
    buildIdValue: unknown,
    token: string | undefined,
    kind: ReportKind,
    body: Readable,
    passed?: unknown,
  ): Promise<void> {
    const { companyId, build } = await this.#authorize(buildIdValue, token);
    const content = await readLimited(body, MAX_REPORT_BYTES[kind]);
    if (kind === 'failure') {
      // Says which jobs failed. It can only fail a build, so it needs no other check.
      const failedJobs = [...content.toString('utf8').matchAll(/(\w+)=(failure|cancelled)/g)].map((match) => match[1]!);
      const failed = failedJobs.map((job) => JOB_NAMES[job] ?? job).join(', ');
      const first = failedJobs[0];
      const advice = first === undefined ? DEFAULT_JOB_ADVICE : (JOB_ADVICE[first] ?? DEFAULT_JOB_ADVICE);
      await runWithCompany(companyId, async () => {
        await this.#store.transaction((session) =>
          session.addReports(build.id, { failedJobs: failedJobs.filter((job) => (PIPELINE_JOBS as readonly string[]).includes(job)) }),
        );
        await this.#fail(build.id, `The pipeline stopped: the ${failed || 'pipeline'} step failed. ${advice}`);
      });
      return;
    }
    await runWithCompany(companyId, async () => {
      let sbom: unknown = null;
      let update: Partial<Record<keyof Reports, unknown>>;
      try {
        switch (kind) {
          case 'secrets':
            update = { secrets: summarizeSecrets(JSON.parse(content.toString('utf8'))) };
            break;
          case 'tests':
            update = { tests: { passed: passed === 'true', log: content.toString('utf8').slice(-60_000) } };
            break;
          case 'build-log':
            // The end of a failed image build's output, which names the instruction that failed.
            update = { buildLog: content.toString('utf8').slice(-60_000) };
            break;
          case 'scan':
            update = { scan: summarizeScan(JSON.parse(content.toString('utf8'))) };
            break;
          case 'sbom':
            sbom = JSON.parse(content.toString('utf8'));
            update = { sbom: { components: countComponents(sbom) } };
            break;
        }
      } catch {
        throw new BuildError('invalid', `The ${kind} report could not be read.`);
      }
      await this.#store.transaction(async (session) => {
        await session.addReports(build.id, update);
        if (sbom !== null) {
          await session.addSbom(build.id, sbom);
        }
      });
      await this.#decide(build.id);
    });
  }

  /** A pipeline job says it started, so people can follow the build. */
  async jobStarted(buildIdValue: unknown, token: string | undefined, jobValue: unknown): Promise<void> {
    if (!(PIPELINE_JOBS as readonly unknown[]).includes(jobValue)) {
      throw new BuildError('not-found', 'There is no such job.');
    }
    const job = jobValue as PipelineJob;
    const { companyId, build } = await this.#authorize(buildIdValue, token);
    await runWithCompany(companyId, () => this.#store.transaction((session) => session.markJobStarted(build.id, job)));
  }

  /**
   * Receives one part of the built image, in base64. The pipeline's tools can only
   * upload text, so the image arrives in parts.
   */
  async receiveImagePart(buildIdValue: unknown, token: string | undefined, partValue: unknown, body: Readable): Promise<void> {
    const { build } = await this.#authorize(buildIdValue, token);
    const part = Number(partValue);
    if (!Number.isInteger(part) || part < 0 || part >= MAX_IMAGE_PARTS) {
      throw new BuildError('invalid', 'The part number is not valid.');
    }
    const encoded = await readLimited(body, MAX_PART_BYTES);
    const content = Buffer.from(encoded.toString('ascii'), 'base64');
    await mkdir(this.#options.workDir, { recursive: true });
    // Written beside it, then renamed, so a part is never read half written, such as when
    // the pipeline sends it again, or another API instance joins the parts.
    const partial = `${this.#partFile(build.id, part)}.${randomUUID()}.partial`;
    await writeFile(partial, content);
    await rename(partial, this.#partFile(build.id, part));
  }

  /**
   * Joins the parts, checks the whole image against the pipeline's hash, then pushes it to
   * the company's registry and records its digest.
   */
  async completeImage(buildIdValue: unknown, token: string | undefined, partsValue: unknown, hashValue: unknown): Promise<void> {
    const { companyId, build } = await this.#authorize(buildIdValue, token);
    const parts = Number(partsValue);
    if (!Number.isInteger(parts) || parts < 1 || parts > MAX_IMAGE_PARTS || typeof hashValue !== 'string' || !/^[0-9a-f]{64}$/.test(hashValue)) {
      throw new BuildError('invalid', 'The image summary is not valid.');
    }
    const file = this.#imageFile(build.id);
    const hash = createHash('sha256');
    let size = 0;
    try {
      const output = createWriteStream(file);
      for (let part = 0; part < parts; part += 1) {
        const content = await readFile(this.#partFile(build.id, part));
        size += content.length;
        if (size > MAX_IMAGE_BYTES) {
          throw new BuildError('too-large', 'The image is too large.');
        }
        hash.update(content);
        if (!output.write(content)) {
          await new Promise<void>((resolve) => output.once('drain', () => resolve()));
        }
      }
      await new Promise<void>((resolve, reject) => output.end((error?: Error | null) => (error ? reject(error) : resolve())));
    } catch (error) {
      await rm(file, { force: true });
      if (error instanceof BuildError) {
        throw error;
      }
      throw new BuildError('invalid', 'Some parts of the image are missing.');
    } finally {
      for (let part = 0; part < Math.min(parts, MAX_IMAGE_PARTS); part += 1) {
        await rm(this.#partFile(build.id, part), { force: true });
      }
    }
    if (hash.digest('hex') !== hashValue) {
      await rm(file, { force: true });
      throw new BuildError('invalid', "The image doesn't match its hash.");
    }

    let inspection;
    try {
      inspection = checkImage(await this.#registry.inspectArchive(file));
    } catch {
      await rm(file, { force: true });
      throw new BuildError('invalid', "The image's settings could not be read.");
    }

    await runWithCompany(companyId, async () => {
      await this.#store.transaction((session) => session.addReports(build.id, { inspection }));
      // An image that breaks the rules is never stored, so nothing can deploy it.
      const broken = failedChecksReason('The image breaks a platform rule', inspection.checks);
      if (broken !== null) {
        await rm(file, { force: true });
        await this.#fail(build.id, broken);
        return;
      }
      const spec = await this.#repositories.locate(build.applicationId);
      const application = await this.#catalog.get(build.applicationId);
      if (spec === null) {
        await this.#fail(build.id, "The application's repository isn't ready.");
        return;
      }
      const repository = `${spec.organization}/${application.slug}`;
      let digest: string;
      try {
        digest = await this.#registry.pushArchive(file, repository, build.tag);
      } catch (error) {
        this.#logger.error(`Pushing the image of build ${build.id} failed: ${String(error)}`);
        await this.#fail(build.id, 'The image could not be stored in the registry.');
        throw new BuildError('invalid', 'The image could not be stored.');
      }
      await this.#store.transaction((session) =>
        session.storeImage(build.id, { digest, ref: `${this.#registry.imageHost}/${repository}:${build.tag}`, size }),
      );
      await this.#decide(build.id);
    });
  }

  /** The stored image, for the scan and SBOM jobs. */
  async image(buildIdValue: unknown, token: string | undefined): Promise<Readable> {
    const { build } = await this.#authorize(buildIdValue, token);
    const file = this.#imageFile(build.id);
    try {
      await stat(file);
    } catch {
      throw new BuildError('not-found', 'The image has not been received yet.');
    }
    return createReadStream(file);
  }

  // ---- Background work

  /**
   * Fails builds that ran past the timeout, such as when a job died without reporting, and
   * builds whose pipeline never got going, and removes uploads nothing will use any more.
   */
  async expireStale(): Promise<void> {
    await this.#removeAbandonedUploads();
    const { stale, unstarted } = await runWithCompany(NO_COMPANY, () =>
      this.#store.transaction(async (session) => ({
        stale: await session.stale(this.#options.timeoutMinutes),
        unstarted: await session.unstarted(this.#options.startTimeoutMinutes),
      })),
    );
    for (const { buildId, companyId } of stale) {
      await runWithCompany(parseCompanyId(companyId), () =>
        this.#fail(buildId, `The build didn't finish within ${this.#options.timeoutMinutes} minutes.`),
      );
    }
    for (const { buildId, companyId } of unstarted) {
      await runWithCompany(parseCompanyId(companyId), () => this.#failUnstarted(buildId));
    }
  }

  /**
   * Fails a running build none of whose jobs has said anything since its pipeline started,
   * unless one just did. Its jobs are waiting for a runner that isn't free or isn't there,
   * or they run but can't reach the platform: either way, waiting longer doesn't help.
   */
  async #failUnstarted(buildId: string): Promise<void> {
    const minutes = this.#options.startTimeoutMinutes;
    const failed = await this.#store.transaction(async (session) => {
      const build = await session.find(buildId, { lock: true });
      if (build === null || build.status !== 'running' || pipelineHasReported(build.reports)) {
        return false;
      }
      await this.#finish(
        session,
        build,
        'failed',
        `No pipeline job started within ${minutes} minutes: the runners may all be busy or offline, or their jobs can't reach the platform. Try the build again later.`,
      );
      return true;
    });
    if (failed) {
      this.#logger.warn(
        `No job of build ${buildId}'s pipeline reported within ${minutes} minutes, so the build failed. ` +
          `Check that the CI runners are online and free, and that their jobs can reach the API at ${this.#options.toolsApiUrl}.`,
      );
    }
  }

  /** Deletes a deleted branch's feature images, which nothing should deploy any more. */
  async removeFeatureImages(applicationId: string, branch: string): Promise<void> {
    const spec = await this.#repositories.locate(applicationId);
    const builds = await this.#store.transaction((session) => session.featureImages(applicationId, branch));
    if (spec === null || builds.length === 0) {
      return;
    }
    const application = await this.#catalog.get(applicationId);
    for (const build of builds) {
      const repository = `${spec.organization}/${application.slug}`;
      await this.#registry.deleteTag(repository, build.tag);
      // The signature is stored under its own tag, so it goes too.
      if (build.digest !== null) {
        await this.#registry.deleteTag(repository, signatureTag(build.digest));
      }
      await this.#store.transaction(async (session) => {
        await session.markDeleted(build.id);
        await session.record([
          FeatureImageDeleted.create({
            companyId: currentCompanyId(),
            payload: { buildId: build.id, applicationId, branch, tag: build.tag },
          }),
        ]);
      });
    }
  }

  // ---- Internals

  /** Checks a pipeline job's token. Unknown builds and wrong tokens get the same answer. */
  async #authorize(buildIdValue: unknown, token: string | undefined): Promise<{ companyId: CompanyId; build: StoredBuild }> {
    const refused = () => new BuildError('unauthorized', 'This build token is not valid.');
    if (typeof buildIdValue !== 'string' || !UUID_PATTERN.test(buildIdValue) || token === undefined) {
      throw refused();
    }
    const company = await runWithCompany(NO_COMPANY, () => this.#store.transaction((session) => session.companyOfBuild(buildIdValue)));
    if (company === null) {
      throw refused();
    }
    const companyId = parseCompanyId(company);
    const build = await runWithCompany(companyId, () => this.#store.transaction((session) => session.find(buildIdValue)));
    if (
      build === null ||
      build.status !== 'running' ||
      build.tokenHash === null ||
      build.tokenExpiresAt === null ||
      build.tokenExpiresAt.getTime() < Date.now() ||
      !timingSafeEqual(Buffer.from(build.tokenHash, 'hex'), Buffer.from(hashToken(token), 'hex'))
    ) {
      throw refused();
    }
    return { companyId, build };
  }

  /**
   * Decides the build once a report or the image arrives. Runs in the build's company.
   *
   * The reports decide it under a short lock. Signing then needs the registry and other
   * modules, so it happens with no transaction open, and a last one records the outcome,
   * if nothing else decided the build meanwhile.
   */
  async #decide(buildId: string): Promise<void> {
    const signable = await this.#store.transaction(async (session) => {
      const build = await session.find(buildId, { lock: true });
      if (build === null || build.status !== 'running') {
        return null;
      }
      const outcome = evaluate(build.reports, build.kind);
      if (outcome.state === 'waiting') {
        return null;
      }
      if (outcome.state === 'failed') {
        await this.#finish(session, build, 'failed', outcome.reason);
        return null;
      }
      if (build.kind === 'check') {
        await this.#finish(session, build, 'succeeded', null);
        return null;
      }
      return build;
    });
    if (signable === null) {
      return;
    }
    const spec = await this.#repositories.locate(signable.applicationId);
    const application = await this.#catalog.get(signable.applicationId);
    const digest = signable.digest;
    if (spec === null || digest === null) {
      await this.#fail(buildId, 'The image was not stored.');
      return;
    }
    const repository = `${spec.organization}/${application.slug}`;
    const payload = signaturePayload(`${this.#registry.imageHost}/${repository}`, digest);
    const purpose = signingPurposeFor(signable.kind);
    const privateKey = await this.#store.transaction((session) => this.#keys.privateKey(session, purpose));
    await this.#registry.pushSignature(repository, digest, payload, signPayload(privateKey, payload));
    // Reads the signature back, as a target would, and checks it with the public key.
    const publicKey = await this.#store.transaction((session) => this.#keys.publicKey(session, purpose));
    const imageName = `${this.#registry.imageHost}/${repository}@${digest}`;
    const verification = checkStoredSignature(
      payload,
      await this.#registry.readSignature(repository, digest),
      (stored, storedSignature) => verifyPayload(publicKey, stored, storedSignature),
      `cosign verify --key ${purpose}.pub --insecure-ignore-tlog=true ${imageName}`,
    );
    const broken = failedChecksReason("The signature doesn't check out", verification.checks);
    await this.#store.transaction(async (session) => {
      const build = await session.find(buildId, { lock: true });
      // Decided meanwhile, such as by the timeout, or by another report that signed it too.
      if (build === null || build.status !== 'running' || build.digest !== digest) {
        return;
      }
      await session.markSigned(buildId, verification);
      await this.#finish(session, build, broken === null ? 'succeeded' : 'failed', broken);
    });
  }

  async #fail(buildId: string, reason: string): Promise<void> {
    await this.#store.transaction(async (session) => {
      const build = await session.find(buildId, { lock: true });
      if (build !== null && (build.status === 'queued' || build.status === 'running')) {
        await this.#finish(session, build, 'failed', reason);
      }
    });
  }

  async #finish(session: BuildsSession, build: StoredBuild, status: 'succeeded' | 'failed', reason: string | null) {
    const finished = await session.finish(build.id, status, reason);
    const built = {
      buildId: build.id,
      applicationId: build.applicationId,
      kind: build.kind,
      branch: build.branch,
      commit: build.commit,
      tag: build.tag,
      version: build.version,
      releaseId: build.releaseId,
    };
    await session.record([
      status === 'succeeded'
        ? BuildSucceeded.create({
            companyId: currentCompanyId(),
            payload: { ...built, imageRef: finished.imageRef, digest: finished.digest, signedWith: finished.signingKey },
          })
        : BuildFailed.create({ companyId: currentCompanyId(), payload: { ...built, reason } }),
    ]);
    await this.#removeUploads(build.id);
  }

  /** Removes what a build's pipeline uploaded: the joined image and any parts left. */
  async #removeUploads(buildId: string): Promise<void> {
    await rm(this.#imageFile(buildId), { force: true });
    const names = await readdir(this.#options.workDir).catch(() => [] as string[]);
    for (const name of names.filter((entry) => entry.startsWith(`${buildId}.part-`))) {
      await rm(join(this.#options.workDir, name), { force: true });
    }
  }

  /**
   * Removes uploads nothing will use: files older than any build can run, such as those of
   * a build that ended while its API instance was down.
   */
  async #removeAbandonedUploads(): Promise<void> {
    const cutoff = Date.now() - (this.#options.timeoutMinutes + ABANDONED_UPLOAD_GRACE_MINUTES) * 60_000;
    const names = await readdir(this.#options.workDir).catch(() => [] as string[]);
    for (const name of names.filter((entry) => UPLOAD_FILE.test(entry))) {
      const path = join(this.#options.workDir, name);
      const modified = await stat(path).then((found) => found.mtimeMs, () => null);
      if (modified !== null && modified < cutoff) {
        await rm(path, { force: true });
      }
    }
  }

  #imageFile(buildId: string): string {
    return join(this.#options.workDir, `${buildId}.tar`);
  }

  #partFile(buildId: string, part: number): string {
    return join(this.#options.workDir, `${buildId}.part-${part}`);
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BuildError('invalid', `The ${what} ID is not valid.`);
  }
  return value;
}

function toView(build: StoredBuild): BuildView {
  return {
    id: build.id,
    applicationId: build.applicationId,
    kind: build.kind,
    branch: build.branch,
    commit: build.commit,
    tag: build.tag,
    version: build.version,
    releaseId: build.releaseId,
    status: build.status,
    failureReason: build.failureReason,
    reports: build.reports,
    progress: buildProgress(build.kind, build.status, build.reports),
    imageRef: build.imageRef,
    digest: build.digest,
    signedWith: build.status === 'succeeded' ? build.signingKey : null,
    createdAt: build.createdAt.toISOString(),
    finishedAt: build.finishedAt?.toISOString() ?? null,
  };
}

async function readLimited(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      throw new BuildError('too-large', 'The report is too large.');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
