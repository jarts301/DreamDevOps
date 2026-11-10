import { describe, expect, it } from 'vitest';
import { desiredObjects, pullSecret } from '../src/cluster.ts';
import type { Configuration } from '../src/platform.ts';

const configuration: Configuration = {
  environment: { id: 'e-1', name: 'Production', slug: 'production', kind: 'production', acceptedImages: ['final'] },
  registry: { host: 'registry.test', organization: 'acme', username: 'acme-pull', token: 'pull-token' },
  trustedKey: '-----BEGIN PUBLIC KEY-----\nrelease\n-----END PUBLIC KEY-----\n',
  git: { url: 'ssh://git@git.test:22/acme/environment-production.git', branch: 'main', knownHosts: '[git.test]:22 ssh-ed25519 AAAA' },
  secrets: { url: 'http://openbao.test', mount: 'dreamdevops', path: 'c-1/e-1', token: 'read-token', expiresAt: '2030-01-01T00:00:00Z' },
};

const objects = () => desiredObjects(configuration, 'ssh-private-key');
const byKind = (kind: string) => objects().find((object) => object.kind === kind)!;
const byName = (name: string) => objects().find((object) => object.metadata.name === name)!;

describe('the cluster set-up', () => {
  it('points Flux at the environment repository, read with the agent deploy key', () => {
    expect(byKind('GitRepository').spec).toEqual({
      interval: '1m',
      url: 'ssh://git@git.test:22/acme/environment-production.git',
      ref: { branch: 'main' },
      secretRef: { name: 'dreamdevops-git' },
    });
    expect(byName('dreamdevops-git').stringData).toEqual({
      identity: 'ssh-private-key',
      known_hosts: '[git.test]:22 ssh-ed25519 AAAA',
    });
    expect(byKind('Kustomization').spec).toMatchObject({ path: './', prune: true });
  });

  it('lets in only images signed with the trusted key, in the namespaces it manages', () => {
    const spec = byKind('ClusterPolicy').spec as { rules: { match: unknown; verifyImages: Record<string, unknown>[] }[] };
    const rule = spec.rules[0]!;
    const check = rule.verifyImages[0]!;

    expect(rule.match).toEqual({
      any: [{ resources: { kinds: ['Pod'], namespaceSelector: { matchLabels: { 'dreamdevops.io/managed': 'true' } } } }],
    });
    expect(check).toMatchObject({ imageReferences: ['*'], failureAction: 'Enforce', required: true, mutateDigest: true });
    expect(JSON.stringify(check.attestors)).toContain('release');
  });

  it('reads secrets with a token limited to this environment', () => {
    const store = byKind('ClusterSecretStore').spec as { provider: { vault: Record<string, unknown> } };

    expect(store.provider.vault).toMatchObject({ server: 'http://openbao.test', path: 'dreamdevops', version: 'v2' });
    expect(byName('openbao-token').stringData).toEqual({ token: 'read-token' });
  });

  it('gives each namespace a registry login for the company images only', () => {
    const secret = pullSecret(configuration, 'billing');
    const config = JSON.parse((secret.stringData as Record<string, string>)['.dockerconfigjson']!);

    expect(secret).toMatchObject({ type: 'kubernetes.io/dockerconfigjson', metadata: { namespace: 'billing' } });
    expect(Object.keys(config.auths)).toEqual(['registry.test']);
    expect(Buffer.from(config.auths['registry.test'].auth, 'base64').toString()).toBe('acme-pull:pull-token');
  });
});
