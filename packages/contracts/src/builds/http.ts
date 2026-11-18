/** Builds' HTTP API, as the dashboard sees it. Types and plain values only, so a browser app can use them. */

/** A feature image from a branch, a release candidate, a release's final image, or a check of a pull request, which makes no image. */
export const BUILD_KINDS = ['feature', 'rc', 'final', 'check'] as const;
export type BuildKind = (typeof BUILD_KINDS)[number];

export type BuildStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'deleted';

/** Which of the company's keys signs an image: the test key, or the release key for final images. */
export type SigningPurpose = 'test' | 'release';

/** The pipeline's jobs, in the order they run. Checks run only the first two. */
export const PIPELINE_JOBS = ['secrets', 'test', 'image', 'scan', 'sbom'] as const;
export type PipelineJob = (typeof PIPELINE_JOBS)[number];

/**
 * Every step of a build, in order: the pipeline's jobs, and the checks the platform runs
 * itself, on the Dockerfile, the image it received, and the signature it stored.
 */
export const BUILD_STEPS = ['dockerfile', 'secrets', 'test', 'image', 'inspect', 'scan', 'sbom', 'verify'] as const;
export type BuildStep = (typeof BUILD_STEPS)[number];

/** One rule a step checked. A warning is shown but doesn't stop the build. */
export interface Check {
  readonly name: string;
  readonly outcome: 'passed' | 'failed' | 'warning';
  readonly detail: string | null;
}

/** Something a step found out, such as the digest it published. */
export interface Fact {
  readonly label: string;
  readonly value: string;
}

export interface SecretsReport {
  readonly found: number;
  /** Where each finding is, never the secret itself. */
  readonly findings: readonly { readonly rule: string; readonly file: string; readonly line: number }[];
}

export interface TestsReport {
  readonly passed: boolean;
  /** The end of the test output. */
  readonly log: string;
}

export interface ScanReport {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly unknown: number;
}

/** What the platform checked itself, with what it found. */
export interface PlatformChecks {
  readonly checks: readonly Check[];
  readonly facts: readonly Fact[];
}

/** What a build's jobs and the platform's own checks reported, as each came in. */
export interface Reports {
  readonly secrets?: SecretsReport;
  readonly tests?: TestsReport;
  /** The end of a failed image build's output. */
  readonly buildLog?: string;
  readonly image?: { readonly digest: string; readonly size: number };
  readonly scan?: ScanReport;
  readonly sbom?: { readonly components: number };
  /** When each pipeline job started, as the jobs report it. */
  readonly started?: Readonly<Partial<Record<PipelineJob, string>>>;
  /** The jobs the pipeline said failed or were cancelled. */
  readonly failedJobs?: readonly string[];
  /** The platform's own checks: the Dockerfile before the pipeline starts, */
  readonly dockerfile?: PlatformChecks;
  /** the image's settings when it arrives, before it's stored, */
  readonly inspection?: PlatformChecks;
  /** and the signature, read back from the registry once it's signed. */
  readonly verification?: PlatformChecks;
}

export type JobState = 'waiting' | 'running' | 'passed' | 'failed' | 'skipped';

/** Where one step of a build stands. */
export interface JobProgress {
  readonly job: BuildStep;
  readonly state: JobState;
  readonly startedAt: string | null;
  /** What the step checked, with why each failed and how to fix it. */
  readonly checks: readonly Check[];
}

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
  /** Where each step stands. */
  readonly progress: readonly JobProgress[];
  readonly imageRef: string | null;
  readonly digest: string | null;
  readonly signedWith: SigningPurpose | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/** Builds a feature test image from a branch's newest commit. */
export interface RequestFeatureBuild {
  readonly branch: string;
}

/** A public key targets check images with: the test key for feature and RC images, the release key for final ones. */
export interface PublicSigningKey {
  readonly purpose: SigningPurpose;
  /** In PEM. */
  readonly publicKey: string;
}

/** A build's software bill of materials, as the pipeline made it, in CycloneDX JSON. */
export type SbomDocument = Readonly<Record<string, unknown>>;
