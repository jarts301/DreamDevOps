import { createHash } from 'node:crypto';

export type Strategy = 'recreate' | 'rolling' | 'blue-green' | 'canary' | 'a-b';

/** Strategies every edition has. Canary and A/B are progressive, a Commercial feature. */
export const STANDARD_STRATEGIES: readonly Strategy[] = ['recreate', 'rolling', 'blue-green'];
export const PROGRESSIVE_STRATEGIES: readonly Strategy[] = ['canary', 'a-b'];

export const DEPLOYMENT_ANNOTATION = 'dreamdevops.io/deployment';
export const APPLICATION_LABEL = 'dreamdevops.io/application';
export const MANAGED_LABEL = 'dreamdevops.io/managed';
const PULL_SECRET = 'registry-pull';
const SECRET_STORE = 'dreamdevops';
const REPLICAS = 2;

export interface Runtime {
  readonly port: number;
  readonly livenessPath: string;
  readonly readinessPath: string;
  readonly resources: { readonly cpu: string; readonly memory: string };
}

/** Used when an application's blueprint is unknown. */
export const DEFAULT_RUNTIME: Runtime = {
  port: 8080,
  livenessPath: '/health/live',
  readinessPath: '/health/ready',
  resources: { cpu: '250m', memory: '256Mi' },
};

export interface ApplicationRelease {
  readonly deploymentId: string;
  readonly application: { readonly slug: string; readonly name: string };
  readonly environment: { readonly slug: string; readonly kind: 'test' | 'production' };
  /** By digest, so a moved tag can never change what runs. */
  readonly image: string;
  /** The version people know it by, such as 1.4.0 or a feature tag. */
  readonly version: string;
  readonly strategy: Strategy;
  readonly runtime: Runtime;
  readonly variables: Readonly<Record<string, string>>;
  /** Paths in the secret store, in order; later ones win. Missing paths are left out. */
  readonly secretPaths: readonly string[];
}

/** Where an application's files are in the environment repository. */
export function applicationFolder(slug: string): string {
  return `apps/${slug}`;
}

/**
 * The Kubernetes objects that run one version of an application, by file. Each
 * application gets its own namespace, which the target's policies manage.
 */
export function renderApplication(release: ApplicationRelease): Map<string, string> {
  const { slug } = release.application;
  const labels = { [APPLICATION_LABEL]: slug };
  const configName = `${slug}-config`;
  const secretName = `${slug}-secrets`;
  const config = {
    ...release.variables,
    PORT: String(release.runtime.port),
    DREAMDEVOPS_ENVIRONMENT: release.environment.slug,
    DREAMDEVOPS_VERSION: release.version,
  };
  // Changing a value starts a new rollout, so running pods get it.
  const configHash = createHash('sha256')
    .update(JSON.stringify([config, release.secretPaths]))
    .digest('hex')
    .slice(0, 16);

  const container = {
    name: 'app',
    image: release.image,
    ports: [{ name: 'http', containerPort: release.runtime.port }],
    envFrom: [
      { configMapRef: { name: configName } },
      ...(release.secretPaths.length > 0 ? [{ secretRef: { name: secretName } }] : []),
    ],
    readinessProbe: { httpGet: { path: release.runtime.readinessPath, port: 'http' }, periodSeconds: 5 },
    livenessProbe: { httpGet: { path: release.runtime.livenessPath, port: 'http' }, initialDelaySeconds: 10, periodSeconds: 10 },
    resources: {
      requests: { cpu: release.runtime.resources.cpu, memory: release.runtime.resources.memory },
      limits: { memory: release.runtime.resources.memory },
    },
    securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
  };
  // The deployment is in the pod template too, so every deployment is a new revision, even
  // of the same version: a retry never inherits a failed rollout's state.
  const template = {
    metadata: { labels, annotations: { 'dreamdevops.io/config-hash': configHash, [DEPLOYMENT_ANNOTATION]: release.deploymentId } },
    spec: { imagePullSecrets: [{ name: PULL_SECRET }], containers: [container] },
  };
  const workloadMetadata = {
    name: slug,
    namespace: slug,
    labels,
    annotations: { [DEPLOYMENT_ANNOTATION]: release.deploymentId },
  };

  const files = new Map<string, string>();
  const add = (name: string, object: object) => files.set(`${applicationFolder(slug)}/${name}`, toYaml(object));

  add('namespace.yaml', {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: slug, labels: { ...labels, [MANAGED_LABEL]: 'true' } },
  });
  add('config.yaml', { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: configName, namespace: slug, labels }, data: config });
  if (release.secretPaths.length > 0) {
    add('secrets.yaml', {
      apiVersion: 'external-secrets.io/v1',
      kind: 'ExternalSecret',
      metadata: { name: secretName, namespace: slug, labels },
      spec: {
        refreshInterval: '5m',
        secretStoreRef: { kind: 'ClusterSecretStore', name: SECRET_STORE },
        target: { name: secretName },
        dataFrom: release.secretPaths.map((key) => ({ extract: { key } })),
      },
    });
  }
  // With blue/green, Argo Rollouts points the services at the right pods. Their selector is
  // one field that Flux would replace on every sync, so these manifests leave it to Argo.
  const service = (name: string) => ({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: slug, labels },
    spec: {
      ...(release.strategy === 'blue-green' ? {} : { selector: labels }),
      ports: [{ name: 'http', port: 80, targetPort: 'http' }],
    },
  });
  add('service.yaml', service(slug));

  const selector = { matchLabels: labels };
  if (release.strategy === 'recreate') {
    add('workload.yaml', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: workloadMetadata,
      spec: { replicas: REPLICAS, selector, strategy: { type: 'Recreate' }, template },
    });
  } else if (release.strategy === 'rolling') {
    add('workload.yaml', {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Rollout',
      metadata: workloadMetadata,
      spec: {
        replicas: REPLICAS,
        selector,
        template,
        // With no steps and no traffic router, Argo replaces pods a few at a time.
        strategy: { canary: { maxSurge: '50%', maxUnavailable: 0 } },
      },
    });
  } else if (release.strategy === 'blue-green') {
    add('preview-service.yaml', service(`${slug}-preview`));
    add('workload.yaml', {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Rollout',
      metadata: workloadMetadata,
      spec: {
        replicas: REPLICAS,
        selector,
        template,
        strategy: {
          blueGreen: {
            activeService: slug,
            previewService: `${slug}-preview`,
            // Someone checks the new version on the preview service, then switches traffic.
            autoPromotionEnabled: false,
            // The old version stays up for ten minutes, so switching back is instant.
            scaleDownDelaySeconds: 600,
          },
        },
      },
    });
  } else {
    throw new Error(`The ${release.strategy} strategy isn't available here.`);
  }
  files.set(`${applicationFolder(slug)}/kustomization.yaml`, toYaml({ apiVersion: 'kustomize.config.k8s.io/v1beta1', kind: 'Kustomization', resources: [...files.keys()].map((path) => path.split('/').at(-1)) }));
  return files;
}

/** The repository's root, which lists every application folder for Flux. */
export function renderRoot(applicationSlugs: readonly string[]): string {
  return toYaml({
    apiVersion: 'kustomize.config.k8s.io/v1beta1',
    kind: 'Kustomization',
    resources: [...new Set(applicationSlugs)].sort().map(applicationFolder),
  });
}

/**
 * Writes plain data as YAML. Strings are always quoted, so values such as "yes", "1.0"
 * or "null" stay strings.
 */
export function toYaml(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]\n';
    }
    return value
      .map((item) => {
        if (item !== null && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length > 0) {
          const nested = toYaml(item, indent + 2);
          return `${pad}- ${nested.slice(indent + 2)}`;
        }
        return `${pad}- ${scalar(item)}\n`;
      })
      .join('');
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) {
      return '{}\n';
    }
    return entries
      .map(([key, item]) => {
        const name = /^[A-Za-z0-9_./-]+$/.test(key) ? key : JSON.stringify(key);
        if (item !== null && typeof item === 'object' && (Array.isArray(item) ? item.length > 0 : Object.keys(item).length > 0)) {
          return `${pad}${name}:\n${toYaml(item, Array.isArray(item) ? indent : indent + 2)}`;
        }
        return `${pad}${name}: ${typeof item === 'object' && item !== null ? (Array.isArray(item) ? '[]' : '{}') : scalar(item)}\n`;
      })
      .join('');
  }
  return `${scalar(value)}\n`;
}

function scalar(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return 'null';
  }
  return JSON.stringify(String(value));
}
