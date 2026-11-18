import type { SbomDocument } from '@dreamdevops/contracts/builds/http';
import type { EventLog, Transactional } from '@dreamdevops/shared-kernel';
import type { BuildKind, BuildStatus, Reports, SigningPurpose } from '../domain/build.ts';
import type { ImageDetails, PlatformChecks } from '../domain/image-rules.ts';

export const IMAGE_REGISTRY = Symbol('IMAGE_REGISTRY');
export const PIPELINE_HOST = Symbol('PIPELINE_HOST');

/** Where images are stored, by repository such as company/application. */
export interface ImageRegistry {
  /** The host images are known by, such as localhost:3000. */
  readonly imageHost: string;
  /** Pushes an OCI image layout tar file under a tag. Returns the manifest digest. */
  pushArchive(file: string, repository: string, tag: string): Promise<string>;
  /** Reads an OCI image layout tar file's settings, such as its user and health check, before it's pushed. */
  inspectArchive(file: string): Promise<ImageDetails>;
  /** Stores a Cosign signature next to the image it signs. */
  pushSignature(repository: string, digest: string, payload: Buffer, signature: string): Promise<void>;
  /** Reads back the Cosign signature stored for an image, or null if there's none. */
  readSignature(repository: string, digest: string): Promise<{ payload: Buffer; signature: string } | null>;
  deleteTag(repository: string, tag: string): Promise<void>;
}

/** Runs the platform's pipeline in a company's CI. */
export interface PipelineHost {
  /** Keeps the company's pipeline repository holding exactly the platform's workflows, by file name. */
  ensurePipeline(organization: string, workflows: Readonly<Record<string, string>>): Promise<void>;
  /** Starts one run of a workflow, such as build.yaml. */
  run(organization: string, workflow: string, inputs: Readonly<Record<string, string>>): Promise<void>;
}

/** A build as Builds keeps it. */
export interface StoredBuild {
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
  readonly imageRef: string | null;
  readonly digest: string | null;
  /** Which key signs its image, or null for a check, which makes none. */
  readonly signingKey: SigningPurpose | null;
  /** While its pipeline runs: the hash of the token its jobs prove themselves with, and when it ends. */
  readonly tokenHash: string | null;
  readonly tokenExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

export interface NewBuild {
  readonly id: string;
  readonly applicationId: string;
  readonly kind: BuildKind;
  readonly branch: string | null;
  readonly commit: string;
  readonly tag: string;
  readonly version: string | null;
  readonly releaseId: string | null;
  readonly signingKey: SigningPurpose | null;
  readonly requestedBy: string | null;
}

/** A company's signing key, with its private half encrypted. */
export interface StoredSigningKey {
  readonly purpose: SigningPurpose;
  readonly publicKey: string;
  readonly encryptedPrivateKey: string;
}

/** The current company's builds, their SBOMs and its signing keys, in one transaction. */
export interface BuildsSession extends EventLog {
  /** Lets one request at a time choose whether an application's image is built. */
  lockApplication(applicationId: string): Promise<void>;
  /** The build of an image tag that's queued, running or succeeded, which a new request reuses. */
  reusableBuild(applicationId: string, tag: string): Promise<string | null>;
  add(build: NewBuild): Promise<void>;
  /** One build, locked until the transaction ends when asked. */
  find(id: string, options?: { readonly lock?: boolean }): Promise<StoredBuild | null>;
  /** An application's newest builds. */
  list(applicationId: string, limit: number): Promise<StoredBuild[]>;
  /** An application's newest versions: images that passed every check. */
  versions(applicationId: string, limit: number): Promise<StoredBuild[]>;
  many(ids: readonly string[]): Promise<StoredBuild[]>;
  /** An application's succeeded feature images from a branch. */
  featureImages(applicationId: string, branch: string): Promise<StoredBuild[]>;
  /** Adds reports to a build's, replacing those of the same kind. */
  addReports(id: string, reports: Readonly<Partial<Record<keyof Reports, unknown>>>): Promise<void>;
  /** Records when a pipeline job started, the first time it says so. */
  markJobStarted(id: string, job: string): Promise<void>;
  /** Moves a queued build to running, with its jobs' token, from now. False when it isn't queued any more. */
  startRunning(id: string, tokenHash: string, timeoutMinutes: number): Promise<boolean>;
  /** Records where its image is stored. */
  storeImage(id: string, image: { readonly digest: string; readonly ref: string; readonly size: number }): Promise<void>;
  /** Records that its image is signed, and how the signature checked out. */
  markSigned(id: string, verification: PlatformChecks): Promise<void>;
  /** Ends a build, and its jobs' token, and returns it as it is then. */
  finish(id: string, status: 'succeeded' | 'failed', reason: string | null): Promise<StoredBuild>;
  markDeleted(id: string): Promise<void>;
  sbom(buildId: string): Promise<SbomDocument | null>;
  /** Keeps a build's SBOM. A second one for the same build is ignored. */
  addSbom(buildId: string, document: unknown): Promise<void>;
  /** The company a build belongs to, found without any company's context, or null. */
  companyOfBuild(buildId: string): Promise<string | null>;
  /** Builds in any company still running after a timeout, with their companies. */
  stale(timeoutMinutes: number): Promise<{ readonly buildId: string; readonly companyId: string }[]>;
  /**
   * Running builds in any company whose pipeline started longer ago than the timeout, and
   * none of whose jobs has said anything yet, with their companies.
   */
  unstarted(startTimeoutMinutes: number): Promise<{ readonly buildId: string; readonly companyId: string }[]>;
  signingKey(purpose: SigningPurpose): Promise<StoredSigningKey | null>;
  /** Keeps a new signing key. False when another was kept for the purpose meanwhile. */
  addSigningKey(key: StoredSigningKey): Promise<boolean>;
  /** The company's public keys, by purpose. */
  publicKeys(): Promise<{ readonly purpose: SigningPurpose; readonly publicKey: string }[]>;
}

export const BUILDS_STORE = Symbol('BUILDS_STORE');

export type BuildsStore = Transactional<BuildsSession>;
