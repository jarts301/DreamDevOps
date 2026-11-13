import { describe, expect, it } from 'vitest';
import { parseAllDocuments, parse } from 'yaml';
import { advance, assertAccepts, parseStrategy } from '../src/deployments/domain/deployment.ts';
import { type ApplicationRelease, renderApplication, renderRoot, toYaml } from '../src/deployments/domain/manifests.ts';

const release = (overrides: Partial<ApplicationRelease> = {}): ApplicationRelease => ({
  deploymentId: '11111111-1111-4111-8111-111111111111',
  application: { slug: 'billing-api', name: 'Billing API' },
  environment: { slug: 'staging', kind: 'test' },
  image: 'registry.test/acme/billing-api@sha256:' + 'a'.repeat(64),
  version: '1.4.0',
  strategy: 'rolling',
  runtime: { port: 8080, livenessPath: '/health/live', readinessPath: '/health/ready', resources: { cpu: '250m', memory: '256Mi' } },
  variables: { LOG_LEVEL: 'info', FEATURE_FLAG: 'yes', RATIO: '1.0' },
  secretPaths: ['c-1/e-1/shared', 'c-1/e-1/apps/billing-api'],
  ...overrides,
});

const objects = (files: Map<string, string>) =>
  [...files.entries()].filter(([path]) => !path.endsWith('kustomization.yaml')).map(([, text]) => parse(text) as Record<string, any>);
const byKind = (files: Map<string, string>, kind: string) => objects(files).find((object) => object.kind === kind)!;

describe('manifests', () => {
  it('run the image by digest, in its own managed namespace, with the deployment on the workload', () => {
    const files = renderApplication(release());
    const rollout = byKind(files, 'Rollout');

    expect(byKind(files, 'Namespace').metadata.labels).toEqual({ 'dreamdevops.io/application': 'billing-api', 'dreamdevops.io/managed': 'true' });
    expect(rollout.metadata.annotations).toEqual({ 'dreamdevops.io/deployment': '11111111-1111-4111-8111-111111111111' });
    const container = rollout.spec.template.spec.containers[0];
    expect(container.image).toMatch(/@sha256:a{64}$/);
    expect(rollout.spec.template.spec.imagePullSecrets).toEqual([{ name: 'registry-pull' }]);
    expect(container.readinessProbe.httpGet).toEqual({ path: '/health/ready', port: 'http' });
    expect(rollout.spec.strategy).toEqual({ canary: { maxSurge: '50%', maxUnavailable: 0 } });
  });

  it('keep variables as strings, add the platform ones, and read secrets from the environment then the application', () => {
    const files = renderApplication(release());

    expect(byKind(files, 'ConfigMap').data).toEqual({
      LOG_LEVEL: 'info',
      FEATURE_FLAG: 'yes',
      RATIO: '1.0',
      PORT: '8080',
      DREAMDEVOPS_ENVIRONMENT: 'staging',
      DREAMDEVOPS_VERSION: '1.4.0',
    });
    expect(byKind(files, 'ExternalSecret').spec.dataFrom).toEqual([
      { extract: { key: 'c-1/e-1/shared' } },
      { extract: { key: 'c-1/e-1/apps/billing-api' } },
    ]);
  });

  it('leave secrets out when there are none', () => {
    const files = renderApplication(release({ secretPaths: [] }));

    expect([...files.keys()]).not.toContain('apps/billing-api/secrets.yaml');
    expect(JSON.stringify(byKind(files, 'Rollout'))).not.toContain('secretRef');
  });

  it('use a plain Deployment for recreate, and a preview service with manual promotion for blue/green', () => {
    const recreate = renderApplication(release({ strategy: 'recreate' }));
    expect(byKind(recreate, 'Deployment').spec.strategy).toEqual({ type: 'Recreate' });

    const blueGreen = renderApplication(release({ strategy: 'blue-green' }));
    expect(byKind(blueGreen, 'Rollout').spec.strategy.blueGreen).toMatchObject({
      activeService: 'billing-api',
      previewService: 'billing-api-preview',
      autoPromotionEnabled: false,
    });
    expect(objects(blueGreen).filter((object) => object.kind === 'Service').map((service) => service.metadata.name)).toEqual([
      'billing-api',
      'billing-api-preview',
    ]);
    // Argo owns the selectors of blue/green services; the other strategies select by label.
    expect(objects(blueGreen).filter((object) => object.kind === 'Service').every((service) => service.spec.selector === undefined)).toBe(true);
    expect(byKind(recreate, 'Service').spec.selector).toEqual({ 'dreamdevops.io/application': 'billing-api' });
  });

  it('change the pods when a value changes, so they pick it up', () => {
    const hash = (variables: Record<string, string>) =>
      byKind(renderApplication(release({ variables })), 'Rollout').spec.template.metadata.annotations['dreamdevops.io/config-hash'];
    expect(hash({ A: '1' })).not.toBe(hash({ A: '2' }));
  });

  it('list every file for kustomize, and every application at the root', () => {
    const files = renderApplication(release({ strategy: 'blue-green' }));
    const folder = parse(files.get('apps/billing-api/kustomization.yaml')!);

    expect(folder.resources).toEqual(['namespace.yaml', 'config.yaml', 'secrets.yaml', 'service.yaml', 'preview-service.yaml', 'workload.yaml']);
    expect(parse(renderRoot(['web', 'billing-api', 'web'])).resources).toEqual(['apps/billing-api', 'apps/web']);
  });

  it('write YAML that parses back to the same data', () => {
    const data = { a: 'yes', b: ['x', { c: 1, d: [] }], e: {}, 'f.g/h': 'null', i: 'multi\nline: "quoted"' };
    expect(parseAllDocuments(toYaml(data)).map((document) => document.toJS())).toEqual([data]);
  });
});

describe('deployment rules', () => {
  const environment = (kind: 'test' | 'production', acceptsFeatureImages = true) => ({ name: 'Env', kind, acceptsFeatureImages });

  it('send only final versions to production, and feature images only where they are accepted', () => {
    expect(() => assertAccepts(environment('production'), { kind: 'rc', status: 'succeeded' })).toThrow('Production takes final versions only.');
    expect(() => assertAccepts(environment('test', false), { kind: 'feature', status: 'succeeded' })).toThrow("doesn't accept feature images");
    expect(() => assertAccepts(environment('test'), { kind: 'feature', status: 'failed' })).toThrow('passed every check');
    expect(() => assertAccepts(environment('production'), { kind: 'final', status: 'succeeded' })).not.toThrow();
    expect(() => assertAccepts(environment('test'), { kind: 'rc', status: 'succeeded' })).not.toThrow();
  });

  it('accept the standard strategies and the progressive ones by name', () => {
    expect(parseStrategy('blue-green')).toBe('blue-green');
    expect(parseStrategy('canary')).toBe('canary');
    expect(() => parseStrategy('big-bang')).toThrow('Choose recreate, rolling or blue/green.');
  });

  it('follow the rollout from the agent reports', () => {
    const current = { status: 'committed' as const, commitSha: 'c'.repeat(40) };
    const workload = (phase: 'Progressing' | 'Paused' | 'Healthy' | 'Degraded' | 'Aborted') => ({
      deploymentId: 'd-1',
      phase,
      desired: 2,
      updated: 1,
      ready: 1,
      available: 1,
      message: phase === 'Degraded' ? 'ImagePullBackOff' : null,
    });

    expect(advance(current, undefined, { revision: 'c'.repeat(40), ready: true, message: null })).toEqual({
      status: 'committed',
      progress: { applied: true },
      message: null,
    });
    expect(advance(current, undefined, { revision: null, ready: false, message: 'kustomize build failed' }).message).toBe(
      "Flux can't apply the change: kustomize build failed",
    );
    expect(advance(current, workload('Progressing'), null)).toMatchObject({ status: 'progressing', progress: { applied: true, updated: 1, desired: 2 } });
    expect(advance(current, workload('Paused'), null).status).toBe('paused');
    expect(advance(current, workload('Healthy'), null).status).toBe('succeeded');
    expect(advance(current, workload('Degraded'), null)).toMatchObject({ status: 'failed', message: 'ImagePullBackOff' });
    expect(advance(current, workload('Aborted'), null).status).toBe('aborted');
  });
});
