import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ImageScanner,
  PermanentBuildError,
  type ScanReport,
  type Severity,
  SEVERITIES,
  type Vulnerability,
} from '../application/ports.ts';
import { CommandNotFoundError, lastLines, runCommand } from '../../shared/run-command.ts';

export interface TrivyImageScannerOptions {
  /** The Trivy image to run, such as aquasec/trivy:0.58.1. */
  readonly image: string;
  readonly timeoutMs: number;
  readonly docker?: string;
}

/** Trivy's vulnerability database lives in this volume, so it's downloaded once, not for every scan. */
const CACHE_VOLUME = 'dreamdevops-trivy-cache';
const MAX_FINDINGS = 50;

interface TrivyReport {
  Results?: {
    Vulnerabilities?: {
      VulnerabilityID?: string;
      PkgName?: string;
      InstalledVersion?: string;
      FixedVersion?: string;
      Severity?: string;
      Title?: string;
    }[];
  }[];
}

/**
 * Scans images with Trivy, run as a container. The image is handed over as a file, so
 * the scanner never gets access to the Docker engine itself.
 */
export class TrivyImageScanner implements ImageScanner {
  readonly name = 'Trivy';
  readonly #options: TrivyImageScannerOptions;
  readonly #docker: string;

  constructor(options: TrivyImageScannerOptions) {
    this.#options = options;
    this.#docker = options.docker ?? 'docker';
  }

  async scan(image: string): Promise<ScanReport> {
    const directory = await mkdtemp(join(tmpdir(), 'dreamdevops-scan-'));
    try {
      const saved = await this.#run(['save', '--output', join(directory, 'image.tar'), image]);
      if (saved.code !== 0) {
        throw new Error(`Docker couldn't export the image for scanning: ${lastLines(saved.stderr)}`);
      }
      const scanned = await this.#run([
        'run',
        '--rm',
        '--mount',
        `type=bind,source=${directory},target=/scan,readonly`,
        '--mount',
        `type=volume,source=${CACHE_VOLUME},target=/root/.cache`,
        this.#options.image,
        'image',
        '--input',
        '/scan/image.tar',
        '--scanners',
        'vuln',
        '--format',
        'json',
        '--quiet',
        '--timeout',
        `${Math.max(1, Math.floor(this.#options.timeoutMs / 60_000))}m`,
      ]);
      if (scanned.code !== 0) {
        throw new Error(`Trivy couldn't scan the image: ${lastLines(scanned.stderr)}`);
      }
      return parseTrivyReport(scanned.stdout);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async #run(args: readonly string[]) {
    try {
      return await runCommand(this.#docker, args, { timeoutMs: this.#options.timeoutMs });
    } catch (error) {
      if (error instanceof CommandNotFoundError) {
        throw new PermanentBuildError("Docker isn't installed on the machine that runs the API, so images can't be scanned.");
      }
      throw error;
    }
  }
}

/** Used when scanning is turned off. The scan step shows as skipped. */
export class NoImageScanner implements ImageScanner {
  readonly name = null;

  async scan(): Promise<ScanReport> {
    return { counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, findings: [] };
  }
}

/** Counts each vulnerability once per package, and keeps the most severe findings. */
export function parseTrivyReport(output: string): ScanReport {
  let report: TrivyReport;
  try {
    report = JSON.parse(output) as TrivyReport;
  } catch {
    throw new Error("Trivy's report couldn't be read.");
  }
  const unique = new Map<string, Vulnerability>();
  for (const result of report.Results ?? []) {
    for (const found of result.Vulnerabilities ?? []) {
      const severity = (found.Severity ?? 'UNKNOWN').toLowerCase();
      const vulnerability: Vulnerability = {
        id: found.VulnerabilityID ?? 'unknown',
        severity: (SEVERITIES as readonly string[]).includes(severity) ? (severity as Severity) : 'unknown',
        packageName: found.PkgName ?? 'unknown',
        installedVersion: found.InstalledVersion ?? '',
        fixedVersion: found.FixedVersion ? found.FixedVersion : null,
        title: found.Title ?? null,
      };
      unique.set(`${vulnerability.id}|${vulnerability.packageName}|${vulnerability.installedVersion}`, vulnerability);
    }
  }
  const all = [...unique.values()];
  const counts = Object.fromEntries(
    SEVERITIES.map((severity) => [severity, all.filter((finding) => finding.severity === severity).length]),
  ) as Record<Severity, number>;
  const findings = all
    .sort((left, right) => SEVERITIES.indexOf(left.severity) - SEVERITIES.indexOf(right.severity) || left.id.localeCompare(right.id))
    .slice(0, MAX_FINDINGS);
  return { counts, findings };
}
