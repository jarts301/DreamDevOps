import { type Check, type Fact, failed, failures, passed, warning } from '../../shared/progress.ts';
import { checkDockerfile } from './dockerfile-policy.ts';

/** What the platform checked itself, with what it found. */
export interface PlatformChecks {
  readonly checks: readonly Check[];
  readonly facts: readonly Fact[];
}

/** A built image's settings, as its OCI configuration states them. */
export interface ImageDetails {
  /** The user it runs as, such as "node", "101" or "" for root. */
  readonly user: string;
  readonly healthcheck: boolean;
  readonly exposedPorts: readonly string[];
  readonly sizeBytes: number;
}

/**
 * The repository's Dockerfile, checked before anything runs: it must exist and follow the
 * platform's rules. A missing .dockerignore is only a warning.
 */
export function checkRepositoryFiles(dockerfile: string | null, hasDockerignore: boolean): PlatformChecks {
  const checks: Check[] =
    dockerfile === null
      ? [failed('The repository has a Dockerfile', 'Add a Dockerfile at the top of the repository.')]
      : [passed('The repository has a Dockerfile'), ...checkDockerfile(dockerfile)];
  checks.push(
    hasDockerignore
      ? passed('The repository has a .dockerignore file')
      : warning(
          'The repository has a .dockerignore file',
          'Without one, every file is sent to the build, which is slower and can put unwanted files in the image.',
        ),
  );
  return { checks, facts: [] };
}

/** The built image, checked before the platform stores it: it runs as a non-root user and has a health check. */
export function checkImage(details: ImageDetails): PlatformChecks {
  const user = details.user.split(':')[0] ?? '';
  const root = user === '' || user === 'root' || user === '0';
  return {
    checks: [
      root
        ? failed('It runs as a non-root user', 'The image runs as root. Add a USER instruction with a non-root user.')
        : passed('It runs as a non-root user', `It runs as "${details.user}".`),
      details.healthcheck
        ? passed('It has a health check')
        : failed('It has a health check', 'Add a HEALTHCHECK instruction, so the platform can tell when it is ready.'),
    ],
    facts: [
      { label: 'Size', value: `${(details.sizeBytes / 1_000_000).toFixed(1)} MB` },
      ...(details.exposedPorts.length === 0 ? [] : [{ label: 'Ports', value: details.exposedPorts.join(', ') }]),
    ],
  };
}

/**
 * The signature as the registry gives it back, checked against what was signed and the
 * key it should match. So an image is only called signed once anyone could check it.
 */
export function checkStoredSignature(
  expectedPayload: Buffer,
  stored: { readonly payload: Buffer; readonly signature: string } | null,
  verify: (payload: Buffer, signature: string) => boolean,
  command: string,
): PlatformChecks {
  if (stored === null) {
    return {
      checks: [failed('The registry has the signature', "The registry doesn't return the signature it was given.")],
      facts: [],
    };
  }
  const sameImage = stored.payload.equals(expectedPayload);
  return {
    checks: [
      passed('The registry has the signature'),
      sameImage
        ? passed('It signs this image')
        : failed('It signs this image', 'The stored signature names another image or digest.'),
      sameImage && verify(stored.payload, stored.signature)
        ? passed("It matches the company's key")
        : failed("It matches the company's key", "The stored signature doesn't match the company's public key."),
    ],
    facts: [{ label: 'Check it yourself', value: command }],
  };
}

/**
 * Why checks failed, in one sentence for people, such as "The Dockerfile breaks a
 * platform rule: Base images are pinned by digest. Not pinned: node:24 on line 1."
 */
export function failedChecksReason(what: string, checks: readonly Check[]): string | null {
  const found = failures(checks);
  if (found.length === 0) {
    return null;
  }
  const first = found[0]!;
  const more = found.length > 1 ? ` ${found.length - 1} more ${found.length === 2 ? 'rule' : 'rules'} failed too.` : '';
  return `${what}: ${first.name}. ${first.detail ?? ''}`.trim() + more;
}
