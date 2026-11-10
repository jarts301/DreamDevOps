import { describe, expect, it } from 'vitest';
import { componentObjects } from '../src/components.ts';

describe('the target tools', () => {
  it('are installed by Flux, each as its own release at a pinned version', () => {
    const releases = componentObjects({ insecureRegistry: false }).filter((object) => object.kind === 'HelmRelease');

    expect(releases.map((release) => release.metadata.name)).toEqual(['argo-rollouts', 'kyverno', 'external-secrets']);
    for (const release of releases) {
      const spec = release.spec as { chart: { spec: { version: string } }; install: { crds: string } };
      expect(spec.chart.spec.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(spec.install.crds).toBe('CreateReplace');
    }
  });

  it('let Kyverno check signatures over plain HTTP only when asked, on a local machine', () => {
    const kyverno = (insecureRegistry: boolean) =>
      JSON.stringify(componentObjects({ insecureRegistry }).find((object) => object.metadata.name === 'kyverno' && object.kind === 'HelmRelease'));

    expect(kyverno(false)).not.toContain('allowInsecure');
    expect(kyverno(true)).toContain('"registryClient":{"allowInsecure":true}');
  });
});
