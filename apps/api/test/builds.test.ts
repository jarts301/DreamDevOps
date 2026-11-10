import { generateKeyPairSync } from 'node:crypto';
import { createDomainEvent, parseCompanyId } from '@dreamdevops/shared-kernel';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BlueprintLibrary } from '../src/blueprints/infrastructure/blueprint-library.ts';
import { isFeatureBranch, lineBranch, parseLineBranch } from '../src/builds/domain/branches.ts';
import { checkDockerfile, parseDockerfile } from '../src/builds/domain/dockerfile-policy.ts';
import { defaultSteps } from '../src/builds/application/build-pipeline.ts';
import { BUILD_KINDS } from '../src/builds/domain/versions.ts';
import { initialSteps, STEP_NAMES, stepsFor } from '../src/builds/domain/pipeline.ts';
import {
  InvalidSigningKeyError,
  readPayload,
  SigningKey,
  signaturePayload,
  signatureTag,
  verifySignature,
} from '../src/builds/domain/signature.ts';
import {
  bump,
  candidateVersion,
  compareVersions,
  developmentVersion,
  formatVersion,
  newest,
  parseCoreVersion,
  parseVersion,
} from '../src/builds/domain/versions.ts';
import { isValidWebhookSignature, webhookSecret } from '../src/builds/domain/webhook-signature.ts';
import { parseTrivyReport } from '../src/builds/infrastructure/trivy-image-scanner.ts';
import { summarize } from '../src/notifications/domain/event-catalog.ts';
import { COMPANY_A } from './fakes.ts';
import { createHmac } from 'node:crypto';

const version = (text: string) => {
  const parsed = parseVersion(text);
  if (parsed === null) {
    throw new Error(`${text} should parse`);
  }
  return parsed;
};
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('versions', () => {
  it('read semantic versions that are also image tags', () => {
    expect(parseVersion('1.4.0')).toEqual({ major: 1, minor: 4, patch: 0, prerelease: [] });
    expect(parseVersion('1.4.0-rc.2')).toEqual({ major: 1, minor: 4, patch: 0, prerelease: ['rc', '2'] });
    expect(formatVersion(version('0.2.0-dev.pr12.3'))).toBe('0.2.0-dev.pr12.3');
  });

  it.each(['1.4', 'v1.4.0', '01.4.0', '1.4.0-rc.02', '1.4.0+build.5', '1.4.0-', '1.4.0-rc..1', `1.0.0-${'a'.repeat(130)}`, ''])(
    'refuse %j',
    (text) => {
      expect(parseVersion(text)).toBeNull();
    },
  );

  it('tell plain releases apart from pre-releases', () => {
    expect(parseCoreVersion('2.0.0')).not.toBeNull();
    expect(parseCoreVersion('2.0.0-rc.1')).toBeNull();
  });

  it('sort the way semantic versioning says', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1-hotfix.1',
      '1.0.1',
      '1.10.0',
      '2.0.0',
    ];
    const shuffled = [...ordered].reverse();
    expect(shuffled.sort((left, right) => compareVersions(version(left), version(right)))).toEqual(ordered);
    expect(formatVersion(newest(ordered.map(version))!)).toBe('2.0.0');
    expect(newest([])).toBeNull();
  });

  it('count up from the latest release, or from nothing', () => {
    expect(formatVersion(bump(null, 'minor'))).toBe('0.1.0');
    expect(formatVersion(bump(version('1.4.2'), 'minor'))).toBe('1.5.0');
    expect(formatVersion(bump(version('1.4.2'), 'major'))).toBe('2.0.0');
    expect(formatVersion(bump(version('1.4.2'), 'patch'))).toBe('1.4.3');
  });

  it('name candidates and development images after what they lead to', () => {
    expect(formatVersion(candidateVersion(version('1.5.0'), 'release-candidate', 2))).toBe('1.5.0-rc.2');
    expect(formatVersion(candidateVersion(version('1.4.3'), 'hotfix-candidate', 1))).toBe('1.4.3-hotfix.1');
    expect(formatVersion(developmentVersion(version('1.5.0'), 12, 3))).toBe('1.5.0-dev.pr12.3');
    // Each comes before the release it leads to.
    expect(compareVersions(candidateVersion(version('1.5.0'), 'release-candidate', 9), version('1.5.0'))).toBeLessThan(0);
  });
});

describe('branches', () => {
  it('name release and hotfix branches after their version', () => {
    expect(parseLineBranch('release/1.5.0')).toEqual({ kind: 'release', branch: 'release/1.5.0', version: version('1.5.0') });
    expect(parseLineBranch('hotfix/1.4.3')?.kind).toBe('hotfix');
    expect(lineBranch('hotfix', version('1.4.3'))).toBe('hotfix/1.4.3');
  });

  it.each(['release/next', 'release/1.5', 'release/1.5.0-rc.1', 'feature/1.0.0', 'main', 'release/1.5.0/extra'])(
    'ignore %s as a release line',
    (branch) => {
      expect(parseLineBranch(branch)).toBeNull();
    },
  );

  it('recognise feature branches', () => {
    expect(isFeatureBranch('feature/login')).toBe(true);
    expect(isFeatureBranch('feature/team/login-2')).toBe(true);
    expect(isFeatureBranch('feature/')).toBe(false);
    expect(isFeatureBranch('bugfix/login')).toBe(false);
    expect(isFeatureBranch('feature/../main')).toBe(false);
    expect(isFeatureBranch('feature/with space')).toBe(false);
  });
});

describe('the pipeline', () => {
  it('tags only releases in Git', () => {
    expect(stepsFor('release').at(-1)).toBe('tag');
    for (const kind of ['development', 'release-candidate', 'hotfix-candidate'] as const) {
      expect(stepsFor(kind)).not.toContain('tag');
    }
    // Signing always comes after publishing, and verifying after signing.
    const steps = stepsFor('release');
    expect(steps.indexOf('scan')).toBeLessThan(steps.indexOf('publish'));
    expect(steps.indexOf('publish')).toBeLessThan(steps.indexOf('sign'));
    expect(steps.indexOf('sign')).toBeLessThan(steps.indexOf('verify'));
  });

  it('has exactly one implementation for every step a build can run', () => {
    const steps = defaultSteps({} as never, {} as never, { maxAttempts: 1, sourceUrl: 'http://git.test' });
    const keys = steps.map((step) => step.key);

    expect(new Set(keys).size).toBe(keys.length);
    for (const kind of BUILD_KINDS) {
      for (const key of stepsFor(kind)) {
        expect(keys).toContain(key);
      }
    }
    expect(keys.sort()).toEqual(Object.keys(STEP_NAMES).sort());
  });

  it('starts with every step pending', () => {
    expect(initialSteps('development').every((step) => step.status === 'pending' && step.checks.length === 0)).toBe(true);
  });
});

describe('reading a Dockerfile', () => {
  it('follows continuations, comments, directives and here-documents', () => {
    const instructions = parseDockerfile(
      [
        '# syntax=docker/dockerfile:1',
        '# A comment',
        'from node@sha256:abc AS build',
        'RUN apt-get update \\',
        '  # a comment inside',
        '  && apt-get install -y curl',
        'RUN <<EOF',
        'FROM not-an-instruction',
        'EOF',
        'COPY . .',
      ].join('\n'),
    );

    expect(instructions).toEqual([
      { line: 3, keyword: 'FROM', args: 'node@sha256:abc AS build' },
      { line: 4, keyword: 'RUN', args: 'apt-get update && apt-get install -y curl' },
      { line: 7, keyword: 'RUN', args: '<<EOF' },
      { line: 10, keyword: 'COPY', args: '. .' },
    ]);
  });

  it('uses the escape character a directive sets', () => {
    const instructions = parseDockerfile(['# escape=`', 'FROM windows@sha256:abc', 'RUN dir `', '  C:\\'].join('\n'));
    expect(instructions[1]).toEqual({ line: 3, keyword: 'RUN', args: 'dir C:\\' });
  });
});

describe('the Dockerfile rules', () => {
  const outcome = (dockerfile: string) =>
    Object.fromEntries(checkDockerfile(dockerfile).map((check) => [check.name, check.outcome]));
  const detail = (dockerfile: string, name: string) =>
    checkDockerfile(dockerfile).find((check) => check.name === name)?.detail;
  const pinned = (image: string) => `${image}@sha256:${'b'.repeat(64)}`;

  it('pass both published blueprints', () => {
    const library = BlueprintLibrary.load(fileURLToPath(new URL('../../../blueprints', import.meta.url)));
    for (const manifest of library.latest()) {
      const files = library.render(manifest.key, manifest.version, { name: 'Probe', slug: 'probe' });
      const dockerfile = files.find((file) => file.path === 'Dockerfile')!.content.toString();
      expect(checkDockerfile(dockerfile).every((check) => check.outcome === 'passed')).toBe(true);
    }
  });

  it('need every base image pinned by digest, but not earlier stages or scratch', () => {
    const dockerfile = [`FROM ${pinned('node:24')} AS build`, 'FROM build AS test', 'FROM scratch', `FROM ${pinned('nginx')}`].join('\n');
    expect(outcome(dockerfile)['Base images are pinned by digest']).toBe('passed');
    expect(detail(dockerfile, 'Base images are pinned by digest')).toBe('2 base images, all pinned.');

    expect(detail(`FROM ${pinned('node:24')} AS build\nFROM nginx:latest`, 'Base images are pinned by digest')).toBe(
      'Not pinned: nginx:latest on line 2. Add @sha256:<digest> to each, so every build uses the same base.',
    );
  });

  it('fill in build arguments declared before the first FROM', () => {
    expect(outcome(`ARG BASE=${pinned('node:24')}\nFROM \${BASE}`)['Base images are pinned by digest']).toBe('passed');
    expect(outcome('ARG BASE=node:24\nFROM $BASE')['Base images are pinned by digest']).toBe('failed');
    expect(detail('ARG BASE\nFROM ${BASE}', 'Base images are pinned by digest')).toContain(
      '${BASE} on line 2 uses a build argument without a default',
    );
    expect(outcome(`FROM --platform=linux/amd64 ${pinned('node:24')}`)['Base images are pinned by digest']).toBe('passed');
  });

  it('need a base image', () => {
    expect(outcome('RUN echo hi')['The Dockerfile has a base image']).toBe('failed');
  });

  it('need a checksum for files downloaded with ADD', () => {
    const base = `FROM ${pinned('alpine')}\n`;
    expect(outcome(`${base}ADD https://example.com/tool.tgz /tmp/`)['Downloaded files are checked']).toBe('failed');
    expect(outcome(`${base}ADD git@github.com:org/repo.git /src`)['Downloaded files are checked']).toBe('failed');
    expect(outcome(`${base}ADD --checksum=sha256:${'c'.repeat(64)} https://example.com/tool.tgz /tmp/`)['Downloaded files are checked']).toBe('passed');
    expect(outcome(`${base}ADD local.tgz /tmp/`)['Downloaded files are checked']).toBe('passed');
  });

  it('refuse secrets in build arguments and environment variables', () => {
    const base = `FROM ${pinned('alpine')}\n`;
    for (const line of ['ARG NPM_TOKEN', 'ARG DB_PASSWORD=x', 'ENV API_KEY=abc', 'ENV GITHUB_TOKEN abc', 'ENV A=1 AWS_SECRET_ACCESS_KEY=2']) {
      expect(outcome(`${base}${line}`)['No secrets in build arguments or environment variables']).toBe('failed');
    }
    for (const line of ['ARG NODE_VERSION=24', 'ENV NODE_ENV=production PORT=8080', 'ENV TOKENIZER_MODE fast']) {
      expect(outcome(`${base}${line}`)['No secrets in build arguments or environment variables']).toBe('passed');
    }
  });
});

describe('image signatures', () => {
  const { key } = SigningKey.generate();

  it('are made in cosign format, and check out with the public key', () => {
    const payload = signaturePayload('registry.test/acme/billing', DIGEST);

    expect(JSON.parse(payload.toString())).toEqual({
      critical: {
        identity: { 'docker-reference': 'registry.test/acme/billing' },
        image: { 'docker-manifest-digest': DIGEST },
        type: 'cosign container image signature',
      },
      optional: null,
    });
    expect(verifySignature(key.publicKey, payload, key.sign(payload))).toBe(true);
    expect(readPayload(payload)).toEqual({ repository: 'registry.test/acme/billing', digest: DIGEST });
    expect(signatureTag(DIGEST)).toBe(`sha256-${'a'.repeat(64)}.sig`);
  });

  it("don't check out when anything changed, or with another key", () => {
    const payload = signaturePayload('registry.test/acme/billing', DIGEST);
    const signature = key.sign(payload);
    const other = signaturePayload('registry.test/acme/billing', `sha256:${'b'.repeat(64)}`);

    expect(verifySignature(key.publicKey, other, signature)).toBe(false);
    expect(verifySignature(SigningKey.generate().key.publicKey, payload, signature)).toBe(false);
    expect(verifySignature(key.publicKey, payload, 'not base64 at all!')).toBe(false);
    expect(readPayload(Buffer.from('{"critical":{"type":"something else"}}'))).toBeNull();
    expect(readPayload(Buffer.from('not json'))).toBeNull();
  });

  it('come only from ECDSA P-256 keys', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });

    expect(() => SigningKey.fromPem(rsa.toString())).toThrow(InvalidSigningKeyError);
    expect(() => SigningKey.fromPem(p384.toString())).toThrow('The image signing key must be an ECDSA P-256 key.');
    expect(() => SigningKey.fromPem('not a key')).toThrow(InvalidSigningKeyError);
    const { key: loaded, pem } = SigningKey.generate();
    expect(SigningKey.fromPem(pem).fingerprint).toBe(loaded.fingerprint);
    expect(loaded.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(loaded.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });

  it('refuse anything that is not a digest', () => {
    expect(() => signaturePayload('registry.test/acme/billing', 'latest')).toThrow();
    expect(() => signatureTag('sha256:short')).toThrow();
  });
});

describe('webhook signatures', () => {
  const body = Buffer.from('{"ref":"release/1.0.0"}');
  const sign = (secret: string) => createHmac('sha256', secret).update(body).digest('hex');

  it('use a different secret for each repository', () => {
    const billing = webhookSecret('master', 'acme', 'billing');
    expect(billing).toMatch(/^[0-9a-f]{64}$/);
    expect(billing).not.toBe(webhookSecret('master', 'acme', 'shop'));
    expect(billing).not.toBe(webhookSecret('master', 'other', 'billing'));
    expect(billing).not.toBe(webhookSecret('another master', 'acme', 'billing'));
  });

  it('accept only the exact body, signed with the right secret', () => {
    const secret = webhookSecret('master', 'acme', 'billing');

    expect(isValidWebhookSignature(secret, body, sign(secret))).toBe(true);
    expect(isValidWebhookSignature(secret, body, sign(secret).toUpperCase())).toBe(true);
    expect(isValidWebhookSignature(secret, Buffer.from(`${body.toString()} `), sign(secret))).toBe(false);
    expect(isValidWebhookSignature(secret, body, sign('guess'))).toBe(false);
    expect(isValidWebhookSignature(secret, body, undefined)).toBe(false);
    expect(isValidWebhookSignature(secret, body, 'abc')).toBe(false);
    expect(isValidWebhookSignature(secret, body, `sha256=${sign(secret)}`)).toBe(false);
  });
});

describe("Trivy's report", () => {
  it('is counted by severity, once per package, most severe first', () => {
    const finding = (id: string, severity: string, pkg = 'openssl') => ({
      VulnerabilityID: id,
      PkgName: pkg,
      InstalledVersion: '1.0',
      FixedVersion: '',
      Severity: severity,
    });
    const report = parseTrivyReport(
      JSON.stringify({
        Results: [
          { Vulnerabilities: [finding('CVE-3', 'LOW'), finding('CVE-1', 'CRITICAL'), finding('CVE-2', 'HIGH')] },
          { Vulnerabilities: [finding('CVE-1', 'CRITICAL'), finding('CVE-4', 'WEIRD')] },
          { Target: 'no findings' },
        ],
      }),
    );

    expect(report.counts).toEqual({ critical: 1, high: 1, medium: 0, low: 1, unknown: 1 });
    expect(report.findings.map((entry) => entry.id)).toEqual(['CVE-1', 'CVE-2', 'CVE-3', 'CVE-4']);
    expect(report.findings[0]!.fixedVersion).toBeNull();
    expect(parseTrivyReport('{}').counts.critical).toBe(0);
    expect(() => parseTrivyReport('not json')).toThrow("Trivy's report couldn't be read.");
  });
});

describe('build notifications', () => {
  const event = (eventType: string, payload: object) =>
    createDomainEvent({ eventType, companyId: parseCompanyId(COMPANY_A), payload });

  it('describe releases and builds', () => {
    expect(summarize(event('ReleaseStarted', { name: 'Billing', version: '1.5.0', branch: 'release/1.5.0' }), 'Acme')).toBe(
      'Acme: Release 1.5.0 of "Billing" started on release/1.5.0.',
    );
    expect(summarize(event('HotfixStarted', { name: 'Billing', version: '1.4.3', branch: 'hotfix/1.4.3' }), 'Acme')).toBe(
      'Acme: Hotfix 1.4.3 of "Billing" started on hotfix/1.4.3.',
    );
    expect(
      summarize(event('BuildSucceeded', { name: 'Billing', kind: 'release', version: '1.5.0', image: 'r/acme/billing:1.5.0' }), 'Acme'),
    ).toBe('Acme: Version 1.5.0 of "Billing" is released: r/acme/billing:1.5.0.');
    expect(
      summarize(
        event('BuildSucceeded', { name: 'Billing', kind: 'development', version: '1.5.0-dev.pr2.1', image: 'r/acme/billing:x' }),
        'Acme',
      ),
    ).toBe('Acme: The development image 1.5.0-dev.pr2.1 of "Billing" is ready: r/acme/billing:x.');
    expect(
      summarize(event('BuildFailed', { name: 'Billing', version: '1.5.0-rc.1', step: 'Scan for vulnerabilities' }), 'Acme'),
    ).toBe('Acme: Building 1.5.0-rc.1 of "Billing" failed at "Scan for vulnerabilities".');
  });
});
