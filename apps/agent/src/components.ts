import { SYSTEM_NAMESPACE, TELEMETRY_SECRET } from './cluster.ts';
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
  {
    name: 'opentelemetry-collector',
    repository: { url: 'https://open-telemetry.github.io/opentelemetry-helm-charts' },
    chart: 'opentelemetry-collector',
    // Runs collector 0.120.0.
    version: '0.118.0',
    // Filled in by collectorValues, which needs where to send.
    values: {},
  },
] as const;

/** The collector's name, so applications reach it at http://dreamdevops-otel-collector.dreamdevops-system:4318. */
export const COLLECTOR_NAME = 'dreamdevops-otel-collector';
const TOKEN_FOLDER = '/var/run/dreamdevops-telemetry';
/** The cluster's own namespaces, whose telemetry the platform doesn't keep. */
const SYSTEM_NAMESPACES = ['kube-system', 'kube-public', 'kube-node-lease', 'default', SYSTEM_NAMESPACE];

/**
 * The collector, on every node: it takes applications' metrics and traces over OTLP, reads
 * their containers' logs, adds the namespace each came from, and sends everything to the
 * platform's telemetry gateway with the target's token. The gateway decides which
 * environment and application they belong to.
 */
export function collectorValues(endpoint: string): object {
  const keep = ['k8sattributes', 'filter/system', 'batch'];
  return {
    fullnameOverride: COLLECTOR_NAME,
    mode: 'daemonset',
    image: { repository: 'otel/opentelemetry-collector-contrib' },
    // Applications reach the collector on their own node.
    service: { enabled: true, internalTrafficPolicy: 'Local' },
    // Flux's network policies shut the system namespace to other namespaces, so this lets
    // applications' pods in, on the collector's ports only, and nothing from outside the cluster.
    networkPolicy: { enabled: true, allowIngressFrom: [{ namespaceSelector: {} }] },
    presets: {
      logsCollection: { enabled: true, includeCollectorLogs: false },
      kubernetesAttributes: { enabled: true },
    },
    extraVolumes: [{ name: 'telemetry-token', secret: { secretName: TELEMETRY_SECRET } }],
    extraVolumeMounts: [{ name: 'telemetry-token', mountPath: TOKEN_FOLDER, readOnly: true }],
    resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { memory: '384Mi' } },
    config: {
      extensions: {
        // Read from the file again whenever the agent renews the token.
        'bearertokenauth/platform': { filename: `${TOKEN_FOLDER}/token` },
      },
      processors: {
        'filter/system': {
          error_mode: 'ignore',
          logs: { log_record: SYSTEM_NAMESPACES.map((namespace) => `resource.attributes["k8s.namespace.name"] == "${namespace}"`) },
          metrics: { metric: SYSTEM_NAMESPACES.map((namespace) => `resource.attributes["k8s.namespace.name"] == "${namespace}"`) },
          traces: { span: SYSTEM_NAMESPACES.map((namespace) => `resource.attributes["k8s.namespace.name"] == "${namespace}"`) },
        },
      },
      exporters: {
        'otlphttp/platform': {
          endpoint,
          encoding: 'json',
          compression: 'gzip',
          auth: { authenticator: 'bearertokenauth/platform' },
        },
      },
      service: {
        extensions: ['health_check', 'bearertokenauth/platform'],
        pipelines: {
          metrics: { receivers: ['otlp'], processors: keep, exporters: ['otlphttp/platform'] },
          traces: { receivers: ['otlp'], processors: keep, exporters: ['otlphttp/platform'] },
          logs: { receivers: ['otlp', 'filelog'], processors: keep, exporters: ['otlphttp/platform'] },
        },
      },
    },
  };
}

/**
 * The Flux objects that install the tools. With an insecure registry (only on a local
 * machine), Kyverno is told it may check signatures over plain HTTP. The collector sends
 * to the platform's telemetry gateway.
 */
export function componentObjects(options: { insecureRegistry: boolean; telemetryEndpoint: string }): KubernetesObject[] {
  return COMPONENTS.flatMap((component) => {
    // Kyverno's own setting, which its chart turns into the --allowInsecureRegistry flag.
    const values =
      component.name === 'kyverno' && options.insecureRegistry
        ? { ...component.values, features: { registryClient: { allowInsecure: true } } }
        : component.name === 'opentelemetry-collector'
          ? collectorValues(options.telemetryEndpoint)
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
