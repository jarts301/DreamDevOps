import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import {
  type CompanyId,
  createDomainEvent,
  currentCompanyId,
  parseCompanyId,
  runWithCompany,
} from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { ApplicationCatalog } from '../../catalog/application/application-catalog.ts';
import type { Principal } from '../../identity-access/domain/access.ts';
import type { SourceHost } from '../../source-governance/application/ports.ts';
import type { RepositoryLookup } from '../../source-governance/application/repository-lookup.ts';
import {
  type BuildKind,
  buildProgress,
  type BuildStatus,
  checkTag,
  countComponents,
  evaluate,
  featureTag,
  type JobProgress,
  PIPELINE_JOBS,
  type PipelineJob,
  type Reports,
  signingPurposeFor,
  summarizeScan,
  summarizeSecrets,
} from '../domain/build.ts';
import { signaturePayload, signatureTag, signPayload } from '../domain/cosign.ts';
import { BuildError } from '../domain/errors.ts';
import { TESTS_CHECK } from '../../source-governance/domain/git-flow.ts';
import type { ImageRegistry, PipelineHost } from './ports.ts';
import type { SigningKeys } from './signing-keys.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_COMPANY = parseCompanyId('00000000-0000-0000-0000-000000000000');
const MAX_IMAGE_BYTES = 4 * 1024 * 1024 * 1024;
/** Parts are 16 MiB before base64, which makes them about a third larger. */
const MAX_PART_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_PARTS = 256;
const MAX_REPORT_BYTES: Readonly<Record<ReportKind, number>> = {
  secrets: 5 * 1024 * 1024,
  tests: 256 * 1024,
  scan: 50 * 1024 * 1024,
  sbom: 100 * 1024 * 1024,
  failure: 4 * 1024,
};

const JOB_NAMES: Readonly<Record<string, string>> = {
  secrets: 'secret scan',
  test: 'tests',
  image: 'image build',
  scan: 'vulnerability scan',
  sbom: 'SBOM',
};

export type ReportKind = 'secrets' | 'tests' | 'scan' | 'sbom' | 'failure';

export interface BuildView {
  readonly id: string;
  readonly applicationId: string;
  readonly kind: BuildKind;
  readonly branch: string | null;
  readonly commit: string;
  readonly tag: string;
  readonly version: string | null;
  readonly releaseId: string | null;
  readonly status: BuildStatus;
  readonly failureReason: string | null;
  readonly reports: Reports;
  /** Where each pipeline job stands. */
  readonly progress: readonly JobProgress[];
  readonly imageRef: string | null;
  readonly digest: string | null;
  readonly signedWith: 'test' | 'release' | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface BuildRequest {
  readonly applicationId: string;
  readonly kind: BuildKind;
  readonly branch: string | null;
  readonly commit: string;
  readonly tag: string;
  readonly version: string | null;
  readonly releaseId: string | null;
  readonly actorId: string | null;
}

interface BuildRow {
  id: string;
  application_id: string;
  kind: BuildKind;
  branch: string | null;
  commit_sha: string;
  image_tag: string;
  version: string | null;
  release_id: string | null;
  status: BuildStatus;
  failure_reason: string | null;
  reports: Reports;
  image_ref: string | null;
  digest: string | null;
  signing_key: 'test' | 'release' | null;
  token_hash: string | null;
  token_expires_at: Date | null;
  created_at: Date;
  finished_at: Date | null;
}

export interface BuildsOptions {
  /** Where pipeline jobs reach the API. */
  readonly toolsApiUrl: string;
  readonly workDir: string;
  readonly timeoutMinutes: number;
  /** The platform's workflows by file name, kept in each company's pipeline repository. */
  readonly pipelines: Readonly<Record<'build.yaml' | 'check.yaml', string>>;
}

/**
 * Builds images in the platform's pipeline, and keeps the list of versions. The platform,
 * not the pipeline, pushes and signs images, and decides from the jobs' reports whether a
 * build passed.
 */
export class Builds {
  readonly #logger = new Logger(Builds.name);
  readonly #database: TenantDatabase;
  readonly #catalog: ApplicationCatalog;
  readonly #repositories: RepositoryLookup;
  readonly #source: SourceHost;
  readonly #registry: ImageRegistry;
  readonly #pipelines: PipelineHost;
  readonly #keys: SigningKeys;
  readonly #options: BuildsOptions;

  constructor(
    database: TenantDatabase,
    catalog: ApplicationCatalog,
    repositories: RepositoryLookup,
    source: SourceHost,
    registry: ImageRegistry,
    pipelines: PipelineHost,
    keys: SigningKeys,
    options: BuildsOptions,
  ) {
    this.#database = database;
    this.#catalog = catalog;
    this.#repositories = repositories;
    this.#source = source;
    this.#registry = registry;
    this.#pipelines = pipelines;
    this.#keys = keys;
    this.#options = options;
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
    return this.#database.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('builds:' || $1, 0))", [input.applicationId]);
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM builds.builds
         WHERE application_id = $1 AND image_tag = $2 AND status IN ('queued', 'running', 'succeeded')`,
        [input.applicationId, input.tag],
      );
      if (rows[0] !== undefined) {
        return rows[0].id;
      }
      const id = randomUUID();
      await tx.query(
        `INSERT INTO builds.builds
           (id, company_id, application_id, kind, branch, commit_sha, image_tag, version, release_id,
            status, signing_key, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, $11)`,
        [
          id,
          currentCompanyId(),
          input.applicationId,
          input.kind,
          input.branch,
          input.commit,
          input.tag,
          input.version,
          input.releaseId,
          input.kind === 'check' ? null : signingPurposeFor(input.kind),
          input.actorId,
        ],
      );
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'BuildRequested',
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

  /** Starts the pipeline for a requested build. Runs in the build's company. */
  async start(buildId: string): Promise<void> {
    const build = await this.#database.transaction((tx) => findBuild(tx, buildId, { lock: true }));
    if (build === null || build.status !== 'queued') {
      return;
    }
    const spec = await this.#repositories.locate(build.application_id);
    if (spec === null) {
      await this.#fail(buildId, "The application's repository isn't ready.");
      return;
    }
    const token = randomBytes(32).toString('base64url');
    await this.#pipelines.ensurePipeline(spec.organization, this.#options.pipelines);
    await this.#database.transaction((tx) =>
      tx.query(
        `UPDATE builds.builds
         SET status = 'running', token_hash = $2, token_expires_at = now() + make_interval(mins => $3), updated_at = now()
         WHERE id = $1 AND status = 'queued'`,
        [buildId, hashToken(token), this.#options.timeoutMinutes],
      ),
    );
    try {
      await this.#pipelines.run(spec.organization, build.kind === 'check' ? 'check.yaml' : 'build.yaml', {
        build: buildId,
        token,
        api: this.#options.toolsApiUrl,
      });
    } catch (error) {
      await this.#fail(buildId, 'The pipeline could not be started.');
      throw error;
    }
  }

  // ---- Reads

  list(applicationIdValue: unknown): Promise<BuildView[]> {
    const applicationId = parseId(applicationIdValue, 'application');
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<BuildRow>(
        `SELECT * FROM builds.builds WHERE application_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [applicationId],
      );
      return rows.map(toView);
    });
  }

  /** The status of each build, for other modules, such as releases. Unknown IDs are left out. */
  async statuses(buildIds: readonly string[]): Promise<Map<string, BuildStatus>> {
    if (buildIds.length === 0) {
      return new Map();
    }
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string; status: BuildStatus }>(
        'SELECT id, status FROM builds.builds WHERE id = ANY($1)',
        [buildIds],
      );
      return new Map(rows.map((row) => [row.id, row.status]));
    });
  }

  /** Several builds by ID, for other modules, such as deployments. Unknown IDs are left out. */
  async many(buildIds: readonly string[]): Promise<Map<string, BuildView>> {
    if (buildIds.length === 0) {
      return new Map();
    }
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<BuildRow>('SELECT * FROM builds.builds WHERE id = ANY($1)', [buildIds]);
      return new Map(rows.map((row) => [row.id, toView(row)]));
    });
  }

  /** The deployable versions: signed images that passed every check. */
  versions(applicationIdValue: unknown): Promise<BuildView[]> {
    const applicationId = parseId(applicationIdValue, 'application');
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<BuildRow>(
        `SELECT * FROM builds.builds WHERE application_id = $1 AND status = 'succeeded' AND kind <> 'check'
         ORDER BY created_at DESC LIMIT 200`,
        [applicationId],
      );
      return rows.map(toView);
    });
  }

  async get(buildIdValue: unknown): Promise<BuildView> {
    const buildId = parseId(buildIdValue, 'build');
    const build = await this.#database.transaction((tx) => findBuild(tx, buildId));
    if (build === null) {
      throw new BuildError('not-found', 'This build does not exist.');
    }
    return toView(build);
  }

  async sbom(buildIdValue: unknown): Promise<object> {
    const buildId = parseId(buildIdValue, 'build');
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<{ document: object }>('SELECT document FROM builds.sboms WHERE build_id = $1', [
        buildId,
      ]);
      if (rows[0] === undefined) {
        throw new BuildError('not-found', 'This build has no SBOM.');
      }
      return rows[0].document;
    });
  }

  publicKeys(): Promise<object[]> {
    return this.#database.transaction((tx) => this.#keys.publicKeys(tx));
  }

  // ---- Pipeline jobs. They have no session; each call proves itself with the build's token.

  async source(buildIdValue: unknown, token: string | undefined): Promise<ReadableStream<Uint8Array>> {
    const { companyId, build } = await this.#authorize(buildIdValue, token);
    return runWithCompany(companyId, async () => {
      const spec = await this.#repositories.locate(build.application_id);
      if (spec === null) {
        throw new BuildError('not-found', "The application's repository isn't ready.");
      }
      return this.#source.downloadArchive(spec, build.commit_sha);
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
      await runWithCompany(companyId, async () => {
        await this.#database.transaction((tx) =>
          tx.query('UPDATE builds.builds SET reports = reports || $2::jsonb, updated_at = now() WHERE id = $1', [
            build.id,
            JSON.stringify({ failedJobs: failedJobs.filter((job) => (PIPELINE_JOBS as readonly string[]).includes(job)) }),
          ]),
        );
        await this.#fail(build.id, `The pipeline stopped: the ${failed || 'pipeline'} step failed.`);
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
      await this.#database.transaction(async (tx) => {
        await tx.query(
          'UPDATE builds.builds SET reports = reports || $2::jsonb, updated_at = now() WHERE id = $1',
          [build.id, JSON.stringify(update)],
        );
        if (sbom !== null) {
          await tx.query(
            'INSERT INTO builds.sboms (build_id, company_id, document) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [build.id, companyId, JSON.stringify(sbom)],
          );
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
    await runWithCompany(companyId, () =>
      this.#database.transaction((tx) =>
        tx.query(
          `UPDATE builds.builds
           SET reports = jsonb_set(reports, '{started}', coalesce(reports->'started', '{}'::jsonb) || jsonb_build_object($2::text, now()))
           WHERE id = $1 AND NOT coalesce(reports->'started' ? $2, false)`,
          [build.id, job],
        ),
      ),
    );
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
    await writeFile(this.#partFile(build.id, part), content);
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

    await runWithCompany(companyId, async () => {
      const spec = await this.#repositories.locate(build.application_id);
      const application = await this.#catalog.get(build.application_id);
      if (spec === null) {
        await this.#fail(build.id, "The application's repository isn't ready.");
        return;
      }
      const repository = `${spec.organization}/${application.slug}`;
      let digest: string;
      try {
        digest = await this.#registry.pushArchive(file, repository, build.image_tag);
      } catch (error) {
        this.#logger.error(`Pushing the image of build ${build.id} failed: ${String(error)}`);
        await this.#fail(build.id, 'The image could not be stored in the registry.');
        throw new BuildError('invalid', 'The image could not be stored.');
      }
      await this.#database.transaction((tx) =>
        tx.query(
          `UPDATE builds.builds
           SET digest = $2, image_ref = $3, reports = reports || $4::jsonb, updated_at = now()
           WHERE id = $1`,
          [
            build.id,
            digest,
            `${this.#registry.imageHost}/${repository}:${build.image_tag}`,
            JSON.stringify({ image: { digest, size } }),
          ],
        ),
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

  /** Fails builds that ran past the timeout, such as when a job died without reporting. */
  async expireStale(): Promise<void> {
    const stale = await runWithCompany(NO_COMPANY, () =>
      this.#database.transaction(async (tx) => {
        const { rows } = await tx.query<{ build_id: string; company_id: string }>(
          "SELECT * FROM builds.stale_builds(now() - make_interval(mins => $1))",
          [this.#options.timeoutMinutes],
        );
        return rows;
      }),
    );
    for (const { build_id: buildId, company_id: companyId } of stale) {
      await runWithCompany(parseCompanyId(companyId), () =>
        this.#fail(buildId, `The build didn't finish within ${this.#options.timeoutMinutes} minutes.`),
      );
    }
  }

  /** Deletes a deleted branch's feature images, which nothing should deploy any more. */
  async removeFeatureImages(applicationId: string, branch: string): Promise<void> {
    const spec = await this.#repositories.locate(applicationId);
    const builds = await this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<BuildRow>(
        "SELECT * FROM builds.builds WHERE application_id = $1 AND kind = 'feature' AND branch = $2 AND status = 'succeeded'",
        [applicationId, branch],
      );
      return rows;
    });
    if (spec === null || builds.length === 0) {
      return;
    }
    const application = await this.#catalog.get(applicationId);
    for (const build of builds) {
      const repository = `${spec.organization}/${application.slug}`;
      await this.#registry.deleteTag(repository, build.image_tag);
      // The signature is stored under its own tag, so it goes too.
      if (build.digest !== null) {
        await this.#registry.deleteTag(repository, signatureTag(build.digest));
      }
      await this.#database.transaction(async (tx) => {
        await tx.query("UPDATE builds.builds SET status = 'deleted', updated_at = now() WHERE id = $1", [build.id]);
        await appendToOutbox(tx, [
          createDomainEvent({
            eventType: 'FeatureImageDeleted',
            companyId: currentCompanyId(),
            payload: { buildId: build.id, applicationId, branch, tag: build.image_tag },
          }),
        ]);
      });
    }
  }

  // ---- Internals

  /** Checks a pipeline job's token. Unknown builds and wrong tokens get the same answer. */
  async #authorize(buildIdValue: unknown, token: string | undefined): Promise<{ companyId: CompanyId; build: BuildRow }> {
    const refused = () => new BuildError('unauthorized', 'This build token is not valid.');
    if (typeof buildIdValue !== 'string' || !UUID_PATTERN.test(buildIdValue) || token === undefined) {
      throw refused();
    }
    const company = await runWithCompany(NO_COMPANY, () =>
      this.#database.transaction(async (tx) => {
        const { rows } = await tx.query<{ build_company: string | null }>('SELECT builds.build_company($1)', [
          buildIdValue,
        ]);
        return rows[0]?.build_company ?? null;
      }),
    );
    if (company === null) {
      throw refused();
    }
    const companyId = parseCompanyId(company);
    const build = await runWithCompany(companyId, () =>
      this.#database.transaction((tx) => findBuild(tx, buildIdValue)),
    );
    if (
      build === null ||
      build.status !== 'running' ||
      build.token_hash === null ||
      build.token_expires_at === null ||
      build.token_expires_at.getTime() < Date.now() ||
      !timingSafeEqual(Buffer.from(build.token_hash, 'hex'), Buffer.from(hashToken(token), 'hex'))
    ) {
      throw refused();
    }
    return { companyId, build };
  }

  /** Decides the build once a report or the image arrives. Runs in the build's company. */
  async #decide(buildId: string): Promise<void> {
    await this.#database.transaction(async (tx) => {
      const build = await findBuild(tx, buildId, { lock: true });
      if (build === null || build.status !== 'running') {
        return;
      }
      const outcome = evaluate(build.reports, build.kind);
      if (outcome.state === 'waiting') {
        return;
      }
      if (outcome.state === 'failed') {
        await this.#finish(tx, build, 'failed', outcome.reason);
        return;
      }
      if (build.kind === 'check') {
        await this.#finish(tx, build, 'succeeded', null);
        return;
      }
      const spec = await this.#repositories.locate(build.application_id);
      const application = await this.#catalog.get(build.application_id);
      if (spec === null || build.digest === null) {
        await this.#finish(tx, build, 'failed', 'The image was not stored.');
        return;
      }
      const repository = `${spec.organization}/${application.slug}`;
      const payload = signaturePayload(`${this.#registry.imageHost}/${repository}`, build.digest);
      const purpose = signingPurposeFor(build.kind);
      const signature = signPayload(await this.#keys.privateKey(tx, purpose), payload);
      await this.#registry.pushSignature(repository, build.digest, payload, signature);
      await tx.query('UPDATE builds.builds SET signed_at = now() WHERE id = $1', [buildId]);
      await this.#finish(tx, build, 'succeeded', null);
    });
  }

  async #fail(buildId: string, reason: string): Promise<void> {
    await this.#database.transaction(async (tx) => {
      const build = await findBuild(tx, buildId, { lock: true });
      if (build !== null && (build.status === 'queued' || build.status === 'running')) {
        await this.#finish(tx, build, 'failed', reason);
      }
    });
  }

  async #finish(tx: TenantTransaction, build: BuildRow, status: 'succeeded' | 'failed', reason: string | null) {
    const { rows } = await tx.query<BuildRow>(
      `UPDATE builds.builds
       SET status = $2, failure_reason = $3, token_hash = NULL, token_expires_at = NULL,
           finished_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [build.id, status, reason],
    );
    const finished = rows[0]!;
    await appendToOutbox(tx, [
      createDomainEvent({
        eventType: status === 'succeeded' ? 'BuildSucceeded' : 'BuildFailed',
        companyId: currentCompanyId(),
        payload: {
          buildId: build.id,
          applicationId: build.application_id,
          kind: build.kind,
          branch: build.branch,
          commit: build.commit_sha,
          tag: build.image_tag,
          version: build.version,
          releaseId: build.release_id,
          ...(status === 'succeeded'
            ? { imageRef: finished.image_ref, digest: finished.digest, signedWith: finished.signing_key }
            : { reason }),
        },
      }),
    ]);
    await rm(this.#imageFile(build.id), { force: true });
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

async function findBuild(tx: TenantTransaction, id: string, options: { lock?: boolean } = {}): Promise<BuildRow | null> {
  const { rows } = await tx.query<BuildRow>(
    `SELECT * FROM builds.builds WHERE id = $1${options.lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

function toView(row: BuildRow): BuildView {
  return {
    id: row.id,
    applicationId: row.application_id,
    kind: row.kind,
    branch: row.branch,
    commit: row.commit_sha,
    tag: row.image_tag,
    version: row.version,
    releaseId: row.release_id,
    status: row.status,
    failureReason: row.failure_reason,
    reports: row.reports,
    progress: buildProgress(row.kind, row.status, row.reports),
    imageRef: row.image_ref,
    digest: row.digest,
    signedWith: row.status === 'succeeded' ? row.signing_key : null,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
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
