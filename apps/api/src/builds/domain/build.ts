import { type Check, failed, failures, passed, warning } from '../../shared/progress.ts';
import { failedChecksReason, type PlatformChecks } from './image-rules.ts';

/** Images, plus checks: the platform's tests and secret scan for a pull request, with no image. */
export type BuildKind = 'feature' | 'rc' | 'final' | 'check';
export type BuildStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'deleted';
export type SigningPurpose = 'test' | 'release';

/**
 * Feature and RC images are signed with the test key, which production doesn't trust.
 * Only final images, rebuilt from the merged code, get the release key.
 */
export function signingPurposeFor(kind: BuildKind): SigningPurpose {
  return kind === 'final' ? 'release' : 'test';
}

/** The tag a pull request check is known by. It names no image. */
export function checkTag(commit: string): string {
  // The whole commit, so two commits can never share a check.
  return `check-${commit}`;
}

/** The image tag of a feature build: feature-<branch>-<commit>, within the tag rules. */
export function featureTag(branch: string, commit: string): string {
  const name = branch
    .replace(/^feature\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return `feature-${name || 'branch'}-${commit.slice(0, 7)}`;
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

/** The pipeline's jobs, in the order they run. Checks run only the first two. */
export const PIPELINE_JOBS = ['secrets', 'test', 'image', 'scan', 'sbom'] as const;
export type PipelineJob = (typeof PIPELINE_JOBS)[number];

/**
 * Every step of a build, in order: the pipeline's jobs, and the checks the platform runs
 * itself, on the Dockerfile, the image it received, and the signature it stored.
 */
export const BUILD_STEPS = ['dockerfile', 'secrets', 'test', 'image', 'inspect', 'scan', 'sbom', 'verify'] as const;
export type BuildStep = (typeof BUILD_STEPS)[number];
/** A pull request check builds no image, so it has only these. */
const CHECK_STEPS: readonly BuildStep[] = ['dockerfile', 'secrets', 'test'];

export type JobState = 'waiting' | 'running' | 'passed' | 'failed' | 'skipped';

export interface JobProgress {
  readonly job: BuildStep;
  readonly state: JobState;
  readonly startedAt: string | null;
  /** What the step checked, with why each failed and how to fix it. */
  readonly checks: readonly Check[];
}

const STEP_REPORT: Readonly<Record<BuildStep, keyof Reports>> = {
  dockerfile: 'dockerfile',
  secrets: 'secrets',
  test: 'tests',
  image: 'image',
  inspect: 'inspection',
  scan: 'scan',
  sbom: 'sbom',
  verify: 'verification',
};

/**
 * Where each step of a build stands, for people to follow. A job is running once it said
 * it started, and done once its report is in. When the build has finished, steps that
 * never ran count as skipped.
 */
export function buildProgress(
  kind: BuildKind,
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'deleted',
  reports: Reports,
): JobProgress[] {
  const steps = kind === 'check' ? CHECK_STEPS : BUILD_STEPS;
  const finished = status === 'succeeded' || status === 'failed' || status === 'deleted';
  return steps.map((job) => {
    const startedAt = (reports.started as Partial<Record<string, string>> | undefined)?.[job] ?? null;
    const report = reports[STEP_REPORT[job]];
    const checks = stepChecks(job, reports);
    let state: JobState;
    if (reports.failedJobs?.includes(job) || failures(checks).length > 0) {
      state = 'failed';
    } else if (report !== undefined) {
      state = 'passed';
    } else if (finished) {
      state = 'skipped';
    } else {
      state = startedAt === null ? 'waiting' : 'running';
    }
    return { job, state, startedAt, checks };
  });
}

/** What a step found, as checks: the platform's own, or made from a job's report. */
function stepChecks(step: BuildStep, reports: Reports): readonly Check[] {
  switch (step) {
    case 'dockerfile':
      return reports.dockerfile?.checks ?? [];
    case 'inspect':
      return reports.inspection?.checks ?? [];
    case 'verify':
      return reports.verification?.checks ?? [];
    case 'secrets':
      return reports.secrets === undefined
        ? []
        : [
            reports.secrets.found === 0
              ? passed('No secrets in the code')
              : failed('No secrets in the code', secretsAdvice(reports.secrets)),
          ];
    case 'test':
      return reports.tests === undefined
        ? []
        : [
            reports.tests.passed
              ? passed('The tests pass')
              : failed('The tests pass', 'The end of their output is in the test log. Fix the failing tests and push again.'),
          ];
    case 'scan':
      return reports.scan === undefined
        ? []
        : [
            reports.scan.critical === 0
              ? passed('No critical vulnerabilities', `${reports.scan.high} high, ${reports.scan.medium} medium.`)
              : failed('No critical vulnerabilities', scanAdvice(reports.scan)),
            ...(reports.scan.high > 0
              ? [warning('No high vulnerabilities', `${reports.scan.high} found. They don't stop the build, but update soon.`)]
              : []),
          ];
    default:
      return [];
  }
}

function secretsAdvice(report: SecretsReport): string {
  const files = [...new Set(report.findings.map((finding) => finding.file))].slice(0, 3).join(', ');
  return `${report.found} found, in ${files}. Remove them, change them where they're used, since they're in Git's history, and push again.`;
}

function scanAdvice(report: ScanReport): string {
  return `${report.critical} found. Update the base image or the affected packages, then build again.`;
}

export type Outcome =
  | { readonly state: 'waiting' }
  | { readonly state: 'failed'; readonly reason: string }
  | { readonly state: 'passed' };

/**
 * Decides a build from its reports. Any failing gate fails it at once. It passes only
 * when every report is in: no secrets, passing tests, a stored image, no critical
 * vulnerabilities and an SBOM.
 */
export function evaluate(reports: Reports, kind: BuildKind = 'feature'): Outcome {
  const platform =
    failedChecksReason('The Dockerfile breaks a platform rule', reports.dockerfile?.checks ?? []) ??
    failedChecksReason('The image breaks a platform rule', reports.inspection?.checks ?? []);
  if (platform !== null) {
    return { state: 'failed', reason: platform };
  }
  if (reports.secrets !== undefined && reports.secrets.found > 0) {
    return { state: 'failed', reason: `Secrets were found in the code: ${secretsAdvice(reports.secrets)}` };
  }
  if (reports.tests !== undefined && !reports.tests.passed) {
    return { state: 'failed', reason: 'The tests failed. The end of their output is in the test log.' };
  }
  if (reports.scan !== undefined && reports.scan.critical > 0) {
    return { state: 'failed', reason: `The image has critical vulnerabilities: ${scanAdvice(reports.scan)}` };
  }
  const needed = kind === 'check' ? [reports.secrets, reports.tests] : [reports.secrets, reports.tests, reports.image, reports.scan, reports.sbom];
  const complete = needed.every((report) => report !== undefined);
  return complete ? { state: 'passed' } : { state: 'waiting' };
}

type Json = Record<string, unknown>;

/** Reads Gitleaks' JSON report. Secrets are redacted by Gitleaks, and only locations are kept. */
export function summarizeSecrets(report: unknown): SecretsReport {
  if (!Array.isArray(report)) {
    throw new Error('The secrets report is not a list.');
  }
  const findings = report.map((entry) => {
    const finding = (entry ?? {}) as Json;
    return {
      rule: String(finding.RuleID ?? 'unknown').slice(0, 100),
      file: String(finding.File ?? 'unknown').slice(0, 300),
      line: Number(finding.StartLine ?? 0),
    };
  });
  return { found: findings.length, findings: findings.slice(0, 20) };
}

/** Counts Trivy's findings by severity. */
export function summarizeScan(report: unknown): ScanReport {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  const results = ((report ?? {}) as Json).Results;
  if (results !== undefined && !Array.isArray(results)) {
    throw new Error('The scan report is not in the expected format.');
  }
  for (const result of (results ?? []) as Json[]) {
    for (const vulnerability of ((result.Vulnerabilities ?? []) as Json[])) {
      const severity = String(vulnerability.Severity ?? 'UNKNOWN').toLowerCase();
      const key = severity in counts ? (severity as keyof typeof counts) : 'unknown';
      counts[key] += 1;
    }
  }
  return counts;
}

/** Counts the components in a CycloneDX SBOM. */
export function countComponents(sbom: unknown): number {
  const document = (sbom ?? {}) as Json;
  if (document.bomFormat !== 'CycloneDX') {
    throw new Error('The SBOM is not a CycloneDX document.');
  }
  return Array.isArray(document.components) ? document.components.length : 0;
}
