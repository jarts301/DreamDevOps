import { createHmac, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  countComponents,
  evaluate,
  featureTag,
  type Reports,
  signingPurposeFor,
  summarizeScan,
  summarizeSecrets,
} from '../src/builds/domain/build.ts';
import { signaturePayload, signatureTag, signPayload, verifyPayload } from '../src/builds/domain/cosign.ts';
import {
  branchFor,
  parseVersion,
  refusalFor,
  releaseBranch,
  suggestVersion,
  suggestVersions,
} from '../src/releases/domain/version.ts';
import { repositoryOf, translate } from '../src/webhooks/domain/forgejo-events.ts';
import { isValidSignature, webhookSecret } from '../src/webhooks/domain/signature.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);

describe('webhook signatures', () => {
  const secret = webhookSecret('key', 'application-1');
  const body = Buffer.from('{"hello":"world"}');
  const sign = (content: Buffer) => createHmac('sha256', secret).update(content).digest('hex');

  it('give each repository its own secret', () => {
    expect(webhookSecret('key', 'application-1')).not.toBe(webhookSecret('key', 'application-2'));
    expect(webhookSecret('key', 'application-1')).not.toBe(webhookSecret('other key', 'application-1'));
  });

  it('accept only the HMAC of the exact body', () => {
    expect(isValidSignature(secret, body, sign(body))).toBe(true);
    expect(isValidSignature(secret, Buffer.from('{"hello":"World"}'), sign(body))).toBe(false);
    expect(isValidSignature(secret, body, undefined)).toBe(false);
    expect(isValidSignature(secret, body, 'not-hex')).toBe(false);
    expect(isValidSignature(secret, body, 'f'.repeat(64))).toBe(false);
  });
});

describe('Forgejo events', () => {
  it('find the repository', () => {
    expect(repositoryOf({ repository: { full_name: 'acme/billing' } })).toEqual({ organization: 'acme', name: 'billing' });
    expect(repositoryOf({ repository: { full_name: 'acme' } })).toBeNull();
    expect(repositoryOf({ repository: { full_name: 'a/b/c' } })).toBeNull();
    expect(repositoryOf('nonsense')).toBeNull();
  });

  it('turn pushes into code pushes and branch deletions', () => {
    expect(translate('push', { ref: 'refs/heads/feature/x', before: ZERO, after: A, commits: [{}, {}], pusher: { login: 'u1' } })).toEqual([
      { eventType: 'CodePushed', payload: { branch: 'feature/x', before: null, after: A, commits: 2, pushedBy: 'u1' } },
    ]);
    expect(translate('push', { ref: 'refs/heads/feature/x', before: A, after: ZERO })).toEqual([
      { eventType: 'BranchDeleted', payload: { branch: 'feature/x' } },
    ]);
  });

  it('ignore tag pushes, which only the platform makes, and anything malformed', () => {
    expect(translate('push', { ref: 'refs/tags/v1.0.0', before: ZERO, after: A })).toEqual([]);
    expect(translate('push', { ref: 'refs/heads/x', before: ZERO, after: 'not-a-commit' })).toEqual([]);
    expect(translate('push', null)).toEqual([]);
    expect(translate('issues', { action: 'opened' })).toEqual([]);
  });

  it('turn branch creation and deletion into events', () => {
    expect(translate('create', { ref: 'feature/y', ref_type: 'branch', sha: B })).toEqual([
      { eventType: 'BranchCreated', payload: { branch: 'feature/y', commit: B } },
    ]);
    expect(translate('delete', { ref: 'feature/y', ref_type: 'branch' })).toEqual([
      { eventType: 'BranchDeleted', payload: { branch: 'feature/y' } },
    ]);
    expect(translate('create', { ref: 'v1', ref_type: 'tag' })).toEqual([]);
    // As Forgejo sends it, with the full reference.
    expect(translate('create', { ref: 'refs/heads/feature/z', ref_type: 'branch', sha: B })).toEqual([
      { eventType: 'BranchCreated', payload: { branch: 'feature/z', commit: B } },
    ]);
  });

  it('report merged pull requests, but not ones closed without merging', () => {
    const pull = (merged: boolean) => ({
      action: 'closed',
      number: 4,
      pull_request: { number: 4, merged, merge_commit_sha: merged ? B : null, head: { ref: 'release/1.0.0' }, base: { ref: 'main' } },
    });
    expect(translate('pull_request', pull(true))).toEqual([
      { eventType: 'PullRequestMerged', payload: { number: 4, head: 'release/1.0.0', base: 'main', mergeCommit: B } },
    ]);
    expect(translate('pull_request', pull(false))).toEqual([]);
  });

  it('report pull requests opened or updated, with their newest commit', () => {
    for (const action of ['opened', 'reopened', 'synchronized']) {
      expect(
        translate('pull_request', {
          action,
          number: 5,
          pull_request: { number: 5, head: { ref: 'feature/x', sha: A }, base: { ref: 'develop' } },
        }),
      ).toEqual([{ eventType: 'PullRequestUpdated', payload: { number: 5, head: 'feature/x', base: 'develop', headCommit: A } }]);
    }
    expect(
      translate('pull_request', { action: 'edited', number: 5, pull_request: { number: 5, head: { ref: 'x', sha: A }, base: { ref: 'develop' } } }),
    ).toEqual([]);
  });
});

describe('builds', () => {
  const complete: Reports = {
    secrets: { found: 0, findings: [] },
    tests: { passed: true, log: '' },
    image: { digest: `sha256:${'c'.repeat(64)}`, size: 10 },
    scan: { critical: 0, high: 3, medium: 0, low: 0, unknown: 0 },
    sbom: { components: 12 },
  };

  it('pass only when every report is in and clean', () => {
    expect(evaluate(complete)).toEqual({ state: 'passed' });
    const { sbom: _sbom, ...withoutSbom } = complete;
    expect(evaluate(withoutSbom)).toEqual({ state: 'waiting' });
    expect(evaluate({})).toEqual({ state: 'waiting' });
  });

  it('pass a pull request check on tests and secrets alone', () => {
    expect(evaluate({ secrets: complete.secrets!, tests: complete.tests! }, 'check')).toEqual({ state: 'passed' });
    expect(evaluate({ secrets: complete.secrets! }, 'check')).toEqual({ state: 'waiting' });
    expect(evaluate({ secrets: complete.secrets!, tests: { passed: false, log: '' } }, 'check')).toEqual({
      state: 'failed',
      reason: 'The tests failed.',
    });
  });

  it('fail at once on a failing gate, even with reports missing', () => {
    expect(evaluate({ tests: { passed: false, log: 'x' } })).toEqual({ state: 'failed', reason: 'The tests failed.' });
    expect(evaluate({ scan: { ...complete.scan!, critical: 1 } })).toEqual({
      state: 'failed',
      reason: 'The image has 1 critical vulnerabilities.',
    });
    expect(
      evaluate({ secrets: { found: 2, findings: [{ rule: 'r', file: 'a.ts', line: 1 }, { rule: 'r', file: 'a.ts', line: 9 }] } }),
    ).toEqual({ state: 'failed', reason: 'Secrets were found in the code (2), in a.ts.' });
  });

  it('sign only final images with the release key', () => {
    expect(signingPurposeFor('feature')).toBe('test');
    expect(signingPurposeFor('rc')).toBe('test');
    expect(signingPurposeFor('final')).toBe('release');
  });

  it('name feature images after their branch and commit, within the tag rules', () => {
    expect(featureTag('feature/Login Page', A)).toBe('feature-login-page-aaaaaaa');
    expect(featureTag(`feature/${'x'.repeat(300)}`, A)).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
    expect(featureTag('feature/!!!', A)).toBe('feature-branch-aaaaaaa');
  });

  it('read Gitleaks, Trivy and CycloneDX reports', () => {
    expect(summarizeSecrets([{ RuleID: 'aws-access-key', File: 'src/a.ts', StartLine: 3, Secret: 'REDACTED' }])).toEqual({
      found: 1,
      findings: [{ rule: 'aws-access-key', file: 'src/a.ts', line: 3 }],
    });
    expect(
      summarizeScan({ Results: [{ Vulnerabilities: [{ Severity: 'CRITICAL' }, { Severity: 'HIGH' }, { Severity: 'WEIRD' }] }, {}] }),
    ).toEqual({ critical: 1, high: 1, medium: 0, low: 0, unknown: 1 });
    expect(countComponents({ bomFormat: 'CycloneDX', components: [{}, {}] })).toBe(2);
    expect(() => summarizeSecrets({})).toThrow();
    expect(() => countComponents({ bomFormat: 'SPDX' })).toThrow();
  });
});

describe('Cosign signatures', () => {
  it('sign the image by repository and digest, as Cosign expects', () => {
    const digest = `sha256:${'d'.repeat(64)}`;
    const keys = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const payload = signaturePayload('registry.test/acme/app', digest);

    expect(JSON.parse(payload.toString())).toEqual({
      critical: {
        identity: { 'docker-reference': 'registry.test/acme/app' },
        image: { 'docker-manifest-digest': digest },
        type: 'cosign container image signature',
      },
      optional: null,
    });
    const signature = signPayload(keys.privateKey, payload);
    expect(verifyPayload(keys.publicKey, payload, signature)).toBe(true);
    expect(verifyPayload(keys.publicKey, signaturePayload('registry.test/acme/app', `sha256:${'e'.repeat(64)}`), signature)).toBe(
      false,
    );
    expect(signatureTag(digest)).toBe(`sha256-${'d'.repeat(64)}.sig`);
  });
});

describe('release version rules', () => {
  const release = (kind: 'release' | 'hotfix', version: string, status: 'open' | 'merged' | 'published') => ({
    kind,
    version,
    status,
  });

  it('let a hotfix run while a release is open', () => {
    // The bug this fixes: an open 1.1.0 used to make every hotfix "lower than 1.1.0".
    const existing = [release('release', '1.0.0', 'published'), release('release', '1.1.0', 'open')];
    expect(refusalFor('hotfix', [1, 0, 1], existing)).toBeNull();
    expect(suggestVersions(existing)).toEqual({ release: '1.2.0', hotfix: '1.0.1' });
  });

  it('keep a hotfix below an open release, and a release above an open hotfix', () => {
    const openRelease = [release('release', '1.0.0', 'published'), release('release', '1.1.0', 'open')];
    expect(refusalFor('hotfix', [1, 1, 0], openRelease)).toBe('Version 1.1.0 is already used.');
    expect(refusalFor('hotfix', [1, 2, 0], openRelease)).toBe('A hotfix must be lower than the open release 1.1.0.');
    const openHotfix = [release('release', '1.0.0', 'published'), release('hotfix', '1.0.1', 'open')];
    expect(refusalFor('release', [1, 0, 2], openHotfix)).toBeNull();
    expect(refusalFor('release', [1, 0, 1], openHotfix)).toBe('Version 1.0.1 is already used.');
    expect(suggestVersions(openHotfix)).toEqual({ release: '1.1.0', hotfix: '1.0.1' });
  });

  it('always go above every merged version', () => {
    const existing = [release('release', '1.0.0', 'published'), release('hotfix', '1.0.1', 'merged')];
    expect(refusalFor('release', [1, 0, 0], existing)).toBe('Version 1.0.0 is already used.');
    expect(refusalFor('hotfix', [0, 9, 9], existing)).toBe('The version must be higher than 1.0.1, the newest merged version.');
    expect(refusalFor('release', [1, 1, 0], existing)).toBeNull();
    expect(suggestVersions([])).toEqual({ release: '0.1.0', hotfix: '0.0.1' });
  });
});

describe('release versions', () => {
  it('are plain semantic versions', () => {
    expect(parseVersion('1.20.3')).toEqual([1, 20, 3]);
    for (const value of ['1.2', 'v1.2.3', '01.2.3', '1.2.3-rc.1', 7]) {
      expect(() => parseVersion(value)).toThrow('Enter a version such as 1.4.0.');
    }
  });

  it('suggest the next minor version for a release and the next patch for a hotfix', () => {
    expect(suggestVersion(null, 'release')).toBe('0.1.0');
    expect(suggestVersion([1, 4, 2], 'release')).toBe('1.5.0');
    expect(suggestVersion([1, 4, 2], 'hotfix')).toBe('1.4.3');
  });

  it('name and recognize Git Flow branches', () => {
    expect(branchFor('hotfix', '1.0.1')).toBe('hotfix/1.0.1');
    expect(releaseBranch('release/2.0.0')).toEqual({ kind: 'release', version: '2.0.0' });
    expect(releaseBranch('feature/release')).toBeNull();
  });
});
