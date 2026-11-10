import { SYSTEM_NAMESPACE } from './cluster.ts';
import type { KubernetesObject } from './kubernetes.ts';

/**
 * The tools a target runs besides Flux, at pinned versions. Flux's Helm controller
 * installs each one as its own release: together in one Helm release they would pass
 * Kubernetes' 1 MB limit for the release record.
 */
export const COMPONENTS = [
  {
    name: 'argo-rollouts',
    repository: { url: 'https://argoproj.github.io/argo-helm' },
    chart: 'argo-rollouts',
    version: '2.43.8',
    values: { controller: { replicas: 1 }, dashboard: { enabled: false } },
  },
  {
    name: 'kyverno',
    repository: { url: 'https://kyverno.github.io/kyverno/' },
    chart: 'kyverno',
    version: '3.9.2',
    values: {
      admissionController: { replicas: 1 },
      backgroundController: { enabled: true },
      cleanupController: { enabled: false },
      reportsController: { enabled: false },
    },
  },
  {
    name: 'external-secrets',
    repository: { url: 'oci://ghcr.io/external-secrets/charts', type: 'oci' },
    chart: 'external-secrets',
    version: '2.13.0',
    values: { installCRDs: true },
  },
] as const;

/**
 * The Flux objects that install the tools. With an insecure registry (only on a local
 * machine), Kyverno is told it may check signatures over plain HTTP.
 */
export function componentObjects(options: { insecureRegistry: boolean }): KubernetesObject[] {
  return COMPONENTS.flatMap((component) => {
    // Kyverno's own setting, which its chart turns into the --allowInsecureRegistry flag.
    const values =
      component.name === 'kyverno' && options.insecureRegistry
        ? { ...component.values, features: { registryClient: { allowInsecure: true } } }
        : component.values;
    return [
      {
        apiVersion: 'source.toolkit.fluxcd.io/v1',
        kind: 'HelmRepository',
        metadata: { name: component.name, namespace: SYSTEM_NAMESPACE },
        spec: { interval: '24h', ...component.repository },
      },
      {
        apiVersion: 'helm.toolkit.fluxcd.io/v2',
        kind: 'HelmRelease',
        metadata: { name: component.name, namespace: SYSTEM_NAMESPACE },
        spec: {
          interval: '1h',
          chart: {
            spec: {
              chart: component.chart,
              version: component.version,
              sourceRef: { kind: 'HelmRepository', name: component.name },
            },
          },
          install: { crds: 'CreateReplace', remediation: { retries: 5 } },
          upgrade: { crds: 'CreateReplace', remediation: { retries: 5 } },
          values,
        },
      },
    ];
  });
}
