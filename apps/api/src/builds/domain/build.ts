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
  readonly image?: { readonly digest: string; readonly size: number };
  readonly scan?: ScanReport;
  readonly sbom?: { readonly components: number };
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
  if (reports.secrets !== undefined && reports.secrets.found > 0) {
    const files = [...new Set(reports.secrets.findings.map((finding) => finding.file))].slice(0, 3).join(', ');
    return { state: 'failed', reason: `Secrets were found in the code (${reports.secrets.found}), in ${files}.` };
  }
  if (reports.tests !== undefined && !reports.tests.passed) {
    return { state: 'failed', reason: 'The tests failed.' };
  }
  if (reports.scan !== undefined && reports.scan.critical > 0) {
    return { state: 'failed', reason: `The image has ${reports.scan.critical} critical vulnerabilities.` };
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
