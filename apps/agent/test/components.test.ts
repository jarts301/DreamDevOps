import { describe, expect, it } from 'vitest';
import { componentObjects } from '../src/components.ts';

const ENDPOINT = 'https://api.example.com/api/v1/telemetry';

describe('the target tools', () => {
  it('are installed by Flux, each as its own release at a pinned version', () => {
    const releases = componentObjects({ insecureRegistry: false, telemetryEndpoint: ENDPOINT }).filter((object) => object.kind === 'HelmRelease');

    expect(releases.map((release) => release.metadata.name)).toEqual(['argo-rollouts', 'kyverno', 'external-secrets', 'opentelemetry-collector']);
    for (const release of releases) {
      const spec = release.spec as { chart: { spec: { version: string } }; install: { crds: string } };
      expect(spec.chart.spec.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(spec.install.crds).toBe('CreateReplace');
    }
  });

  it('let Kyverno check signatures over plain HTTP only when asked, on a local machine', () => {
    const kyverno = (insecureRegistry: boolean) =>
      JSON.stringify(componentObjects({ insecureRegistry, telemetryEndpoint: ENDPOINT }).find((object) => object.metadata.name === 'kyverno' && object.kind === 'HelmRelease'));

    expect(kyverno(false)).not.toContain('allowInsecure');
    expect(kyverno(true)).toContain('"registryClient":{"allowInsecure":true}');
  });

  it('run a collector on every node, which sends what applications send, and their logs, to the platform with the target token', () => {
    const collector = componentObjects({ insecureRegistry: false, telemetryEndpoint: ENDPOINT }).find(
      (object) => object.kind === 'HelmRelease' && object.metadata.name === 'opentelemetry-collector',
    )!;
    const values = (collector.spec as { values: Record<string, any> }).values;

    expect(values).toMatchObject({
      fullnameOverride: 'dreamdevops-otel-collector',
      mode: 'daemonset',
      image: { repository: 'otel/opentelemetry-collector-contrib' },
      presets: { logsCollection: { enabled: true }, kubernetesAttributes: { enabled: true } },
    });
    expect(values.config.exporters['otlphttp/platform']).toEqual({
      endpoint: ENDPOINT,
      encoding: 'json',
      compression: 'gzip',
      auth: { authenticator: 'bearertokenauth/platform' },
    });
    expect(values.extraVolumes).toEqual([{ name: 'telemetry-token', secret: { secretName: 'dreamdevops-telemetry' } }]);
    expect(values.config.service.pipelines.logs.receivers).toEqual(['otlp', 'filelog']);
    expect(JSON.stringify(values.config.processors['filter/system'])).toContain('dreamdevops-system');
  });
});
