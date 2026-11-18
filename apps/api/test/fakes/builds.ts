import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { SbomDocument } from '@dreamdevops/contracts/builds/http';
import { currentCompanyId, type DomainEvent } from '@dreamdevops/shared-kernel';
import type {
  BuildsSession,
  BuildsStore,
  ImageRegistry,
  NewBuild,
  PipelineHost,
  StoredBuild,
  StoredSigningKey,
} from '../../src/builds/application/ports.ts';
import { pipelineHasReported, type Reports, type SigningPurpose } from '../../src/builds/domain/build.ts';
import type { ImageDetails, PlatformChecks } from '../../src/builds/domain/image-rules.ts';

/** Keeps pushed images and signatures in memory. */
export class FakeImageRegistry implements ImageRegistry {
  readonly imageHost = 'registry.test';
  readonly images = new Map<string, string>();
  readonly signatures = new Map<string, { payload: Buffer; signature: string }>();
  readonly deleted: string[] = [];
  failing = false;
  /** The settings every received image has, as its configuration would state them. */
  details: ImageDetails = { user: 'app', healthcheck: true, exposedPorts: ['8080/tcp'], sizeBytes: 1_000 };
  /** Makes the registry give back another signature than it was given, as a broken or tampered one would. */
  tamper = false;

  async pushArchive(file: string, repository: string, tag: string): Promise<string> {
    if (this.failing) {
      throw new Error('The registry is unavailable.');
    }
    const digest = `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}`;
    this.images.set(`${repository}:${tag}`, digest);
    return digest;
  }

  async inspectArchive(_file: string): Promise<ImageDetails> {
    return this.details;
  }

  async pushSignature(repository: string, digest: string, payload: Buffer, signature: string): Promise<void> {
    this.signatures.set(`${repository}@${digest}`, { payload, signature });
  }

  async readSignature(repository: string, digest: string): Promise<{ payload: Buffer; signature: string } | null> {
    const stored = this.signatures.get(`${repository}@${digest}`) ?? null;
    return stored !== null && this.tamper ? { payload: stored.payload, signature: Buffer.from('forged').toString('base64') } : stored;
  }

  async deleteTag(repository: string, tag: string): Promise<void> {
    this.images.delete(`${repository}:${tag}`);
    this.deleted.push(`${repository}:${tag}`);
  }
}

/** Records pipeline runs instead of starting them, so tests can play the jobs' part. */
export class FakePipelineHost implements PipelineHost {
  /** Each organization's workflows, by file name. */
  readonly pipelines = new Map<string, Readonly<Record<string, string>>>();
  readonly runs: { organization: string; workflow: string; inputs: Readonly<Record<string, string>> }[] = [];
  /** How many of the next pipeline setups fail, as while the Git service is down. Infinity for all of them. */
  setupFailures = 0;
  /** Makes starting a run fail, as when the Git service refuses it. */
  runFailing = false;

  async ensurePipeline(organization: string, workflows: Readonly<Record<string, string>>): Promise<void> {
    if (this.setupFailures > 0) {
      this.setupFailures -= 1;
      throw new Error('The Git service could not add the pipeline (status 503).');
    }
    this.pipelines.set(organization, workflows);
  }

  async run(organization: string, workflow: string, inputs: Readonly<Record<string, string>>): Promise<void> {
    if (this.runFailing) {
      throw new Error('The Git service could not start the pipeline (status 500).');
    }
    this.runs.push({ organization, workflow, inputs });
  }

  /** The one-time token the platform gave a build's run. */
  tokenOf(buildId: string): string | undefined {
    return this.runs.find((run) => run.inputs.build === buildId)?.inputs.token;
  }
}

/** A build as the in-memory store keeps it, with when its pipeline started. */
interface KeptBuild extends StoredBuild {
  readonly companyId: string;
  readonly pipelineStartedAt: Date | null;
}

/**
 * Builds in memory, for fast tests of Builds' own rules. Every transaction sees and changes
 * the same builds, and what it records is kept in events. Times come from now, which tests move.
 */
export class InMemoryBuildsStore implements BuildsStore {
  readonly builds = new Map<string, KeptBuild>();
  readonly events: DomainEvent[] = [];
  readonly sboms = new Map<string, unknown>();
  readonly keys = new Map<SigningPurpose, StoredSigningKey>();
  now = new Date('2026-01-01T12:00:00Z');

  async transaction<T>(work: (session: BuildsSession) => Promise<T>): Promise<T> {
    return work(new InMemoryBuildsSession(this));
  }

  /** Adds a waiting build, as a request does, in the given company. */
  addQueued(build: Omit<NewBuild, 'signingKey' | 'requestedBy'>, companyId: string): void {
    this.builds.set(build.id, {
      ...build,
      companyId,
      status: 'queued',
      failureReason: null,
      reports: {},
      imageRef: null,
      digest: null,
      signingKey: build.kind === 'check' ? null : 'test',
      tokenHash: null,
      tokenExpiresAt: null,
      createdAt: this.now,
      finishedAt: null,
      pipelineStartedAt: null,
    });
  }

  change(id: string, changes: Partial<KeptBuild>): void {
    const build = this.builds.get(id);
    if (build !== undefined) {
      this.builds.set(id, { ...build, ...changes });
    }
  }
}

class InMemoryBuildsSession implements BuildsSession {
  readonly #store: InMemoryBuildsStore;

  constructor(store: InMemoryBuildsStore) {
    this.#store = store;
  }

  async record(events: readonly DomainEvent[]): Promise<void> {
    this.#store.events.push(...events);
  }

  async lockApplication(): Promise<void> {}

  async reusableBuild(applicationId: string, tag: string): Promise<string | null> {
    const reusable = [...this.#store.builds.values()].find(
      (build) => build.applicationId === applicationId && build.tag === tag && ['queued', 'running', 'succeeded'].includes(build.status),
    );
    return reusable?.id ?? null;
  }

  async add(build: NewBuild): Promise<void> {
    this.#store.addQueued(build, currentCompanyId());
  }

  async find(id: string): Promise<StoredBuild | null> {
    return this.#store.builds.get(id) ?? null;
  }

  async list(applicationId: string, limit: number): Promise<StoredBuild[]> {
    return [...this.#store.builds.values()].filter((build) => build.applicationId === applicationId).slice(0, limit);
  }

  async versions(applicationId: string, limit: number): Promise<StoredBuild[]> {
    return (await this.list(applicationId, limit)).filter((build) => build.status === 'succeeded' && build.kind !== 'check');
  }

  async many(ids: readonly string[]): Promise<StoredBuild[]> {
    return ids.flatMap((id) => this.#store.builds.get(id) ?? []);
  }

  async featureImages(applicationId: string, branch: string): Promise<StoredBuild[]> {
    return [...this.#store.builds.values()].filter(
      (build) => build.applicationId === applicationId && build.kind === 'feature' && build.branch === branch && build.status === 'succeeded',
    );
  }

  async addReports(id: string, reports: Readonly<Partial<Record<keyof Reports, unknown>>>): Promise<void> {
    const build = this.#store.builds.get(id);
    if (build !== undefined) {
      this.#store.change(id, { reports: { ...build.reports, ...reports } as Reports });
    }
  }

  async markJobStarted(id: string, job: string): Promise<void> {
    const build = this.#store.builds.get(id);
    if (build !== undefined && build.reports.started?.[job as keyof Reports['started']] === undefined) {
      this.#store.change(id, { reports: { ...build.reports, started: { ...build.reports.started, [job]: this.#store.now.toISOString() } } });
    }
  }

  async startRunning(id: string, tokenHash: string, timeoutMinutes: number): Promise<boolean> {
    if (this.#store.builds.get(id)?.status !== 'queued') {
      return false;
    }
    this.#store.change(id, {
      status: 'running',
      tokenHash,
      tokenExpiresAt: new Date(this.#store.now.getTime() + timeoutMinutes * 60_000),
      pipelineStartedAt: this.#store.now,
    });
    return true;
  }

  async storeImage(id: string, image: { readonly digest: string; readonly ref: string; readonly size: number }): Promise<void> {
    const build = this.#store.builds.get(id)!;
    this.#store.change(id, { digest: image.digest, imageRef: image.ref, reports: { ...build.reports, image: { digest: image.digest, size: image.size } } });
  }

  async markSigned(id: string, verification: PlatformChecks): Promise<void> {
    const build = this.#store.builds.get(id)!;
    this.#store.change(id, { reports: { ...build.reports, verification } });
  }

  async finish(id: string, status: 'succeeded' | 'failed', reason: string | null): Promise<StoredBuild> {
    this.#store.change(id, { status, failureReason: reason, tokenHash: null, tokenExpiresAt: null, finishedAt: this.#store.now });
    return this.#store.builds.get(id)!;
  }

  async markDeleted(id: string): Promise<void> {
    this.#store.change(id, { status: 'deleted' });
  }

  async sbom(buildId: string): Promise<SbomDocument | null> {
    return (this.#store.sboms.get(buildId) as SbomDocument | undefined) ?? null;
  }

  async addSbom(buildId: string, document: unknown): Promise<void> {
    if (!this.#store.sboms.has(buildId)) {
      this.#store.sboms.set(buildId, document);
    }
  }

  async companyOfBuild(buildId: string): Promise<string | null> {
    return this.#store.builds.get(buildId)?.companyId ?? null;
  }

  async stale(timeoutMinutes: number): Promise<{ readonly buildId: string; readonly companyId: string }[]> {
    const cutoff = this.#store.now.getTime() - timeoutMinutes * 60_000;
    return [...this.#store.builds.values()]
      .filter((build) => (build.status === 'queued' || build.status === 'running') && build.createdAt.getTime() < cutoff)
      .map((build) => ({ buildId: build.id, companyId: build.companyId }));
  }

  /** As builds.unstarted_builds does. */
  async unstarted(startTimeoutMinutes: number): Promise<{ readonly buildId: string; readonly companyId: string }[]> {
    const cutoff = this.#store.now.getTime() - startTimeoutMinutes * 60_000;
    return [...this.#store.builds.values()]
      .filter(
        (build) =>
          build.status === 'running' &&
          build.pipelineStartedAt !== null &&
          build.pipelineStartedAt.getTime() < cutoff &&
          !pipelineHasReported(build.reports),
      )
      .map((build) => ({ buildId: build.id, companyId: build.companyId }));
  }

  async signingKey(purpose: SigningPurpose): Promise<StoredSigningKey | null> {
    return this.#store.keys.get(purpose) ?? null;
  }

  async addSigningKey(key: StoredSigningKey): Promise<boolean> {
    if (this.#store.keys.has(key.purpose)) {
      return false;
    }
    this.#store.keys.set(key.purpose, key);
    return true;
  }

  async publicKeys(): Promise<{ readonly purpose: SigningPurpose; readonly publicKey: string }[]> {
    return [...this.#store.keys.values()].map((key) => ({ purpose: key.purpose, publicKey: key.publicKey }));
  }
}
