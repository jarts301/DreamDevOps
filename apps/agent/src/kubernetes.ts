import { readFileSync } from 'node:fs';
import { request } from 'node:https';

/** A Kubernetes object, as the agent writes and reads it. */
export interface KubernetesObject {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: {
    readonly name: string;
    readonly namespace?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly annotations?: Readonly<Record<string, string>>;
    readonly generation?: number;
  };
  readonly [field: string]: unknown;
}

interface ResourceType {
  readonly plural: string;
  readonly namespaced: boolean;
}

/** The kinds the agent touches. Anything else is refused, so a mistake can't reach further. */
const RESOURCES: Readonly<Record<string, ResourceType>> = {
  'v1/Secret': { plural: 'secrets', namespaced: true },
  'v1/Namespace': { plural: 'namespaces', namespaced: false },
  'source.toolkit.fluxcd.io/v1/GitRepository': { plural: 'gitrepositories', namespaced: true },
  'kustomize.toolkit.fluxcd.io/v1/Kustomization': { plural: 'kustomizations', namespaced: true },
  'source.toolkit.fluxcd.io/v1/HelmRepository': { plural: 'helmrepositories', namespaced: true },
  'helm.toolkit.fluxcd.io/v2/HelmRelease': { plural: 'helmreleases', namespaced: true },
  'kyverno.io/v1/ClusterPolicy': { plural: 'clusterpolicies', namespaced: false },
  'external-secrets.io/v1/ClusterSecretStore': { plural: 'clustersecretstores', namespaced: false },
  'argoproj.io/v1alpha1/Rollout': { plural: 'rollouts', namespaced: true },
  'apps/v1/Deployment': { plural: 'deployments', namespaced: true },
};

const FIELD_MANAGER = 'dreamdevops-agent';
const SERVICE_ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';

export class KubernetesError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'KubernetesError';
    this.status = status;
  }
}

/**
 * A small client for the Kubernetes API, with the agent's service account. It uses
 * server-side apply, so the agent owns only the fields it sets.
 */
export class Kubernetes {
  readonly #host: string;
  readonly #port: number;
  readonly #ca: Buffer;

  constructor() {
    this.#host = process.env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc';
    this.#port = Number(process.env.KUBERNETES_SERVICE_PORT ?? 443);
    this.#ca = readFileSync(`${SERVICE_ACCOUNT}/ca.crt`);
  }

  /** Creates or updates the object with the agent's fields. */
  async apply(object: KubernetesObject): Promise<void> {
    await this.#call(
      'PATCH',
      `${objectPath(object.apiVersion, object.kind, object.metadata.name, object.metadata.namespace)}?fieldManager=${FIELD_MANAGER}&force=true`,
      object,
      'application/apply-patch+yaml',
    );
  }

  async get<T>(apiVersion: string, kind: string, name: string, namespace?: string): Promise<T | null> {
    try {
      return (await this.#call('GET', objectPath(apiVersion, kind, name, namespace))) as T;
    } catch (error) {
      if (error instanceof KubernetesError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /** Lists objects of a kind in every namespace, by label. Missing kinds give an empty list. */
  async list<T>(apiVersion: string, kind: string, labelSelector?: string): Promise<T[]> {
    const query = labelSelector === undefined ? '' : `?labelSelector=${encodeURIComponent(labelSelector)}`;
    try {
      return ((await this.#call('GET', `${collectionPath(apiVersion, kind)}${query}`)) as { items: T[] }).items;
    } catch (error) {
      if (error instanceof KubernetesError && error.status === 404) {
        return [];
      }
      throw error;
    }
  }

  /** Merges a patch into an object, or into its status. */
  async patch(apiVersion: string, kind: string, name: string, namespace: string, patch: object, subresource?: 'status'): Promise<void> {
    const path = `${objectPath(apiVersion, kind, name, namespace)}${subresource === undefined ? '' : `/${subresource}`}`;
    await this.#call('PATCH', path, patch, 'application/merge-patch+json');
  }

  async version(): Promise<string> {
    return ((await this.#call('GET', '/version')) as { gitVersion: string }).gitVersion;
  }

  #call(method: string, path: string, body?: object, contentType = 'application/json'): Promise<unknown> {
    const token = readFileSync(`${SERVICE_ACCOUNT}/token`, 'utf8').trim();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          host: this.#host,
          port: this.#port,
          method,
          path,
          ca: this.#ca,
          timeout: 30_000,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(payload !== undefined && { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(payload) }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = response.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              resolve(text === '' ? null : JSON.parse(text));
            } else {
              const message = (() => {
                try {
                  return (JSON.parse(text) as { message?: string }).message ?? text;
                } catch {
                  return text;
                }
              })();
              reject(new KubernetesError(status, `Kubernetes refused ${method} ${path.split('?')[0]}: ${message.slice(0, 300)}`));
            }
          });
        },
      );
      outgoing.on('timeout', () => outgoing.destroy(new Error('Kubernetes did not answer in time.')));
      outgoing.on('error', reject);
      if (payload !== undefined) {
        outgoing.write(payload);
      }
      outgoing.end();
    });
  }
}

function resourceOf(apiVersion: string, kind: string): ResourceType {
  const resource = RESOURCES[`${apiVersion}/${kind}`];
  if (resource === undefined) {
    throw new Error(`The agent doesn't manage ${kind} (${apiVersion}).`);
  }
  return resource;
}

function collectionPath(apiVersion: string, kind: string, namespace?: string): string {
  const resource = resourceOf(apiVersion, kind);
  const base = apiVersion.includes('/') ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
  return resource.namespaced && namespace !== undefined
    ? `${base}/namespaces/${encodeURIComponent(namespace)}/${resource.plural}`
    : `${base}/${resource.plural}`;
}

function objectPath(apiVersion: string, kind: string, name: string, namespace?: string): string {
  const resource = resourceOf(apiVersion, kind);
  if (resource.namespaced && namespace === undefined) {
    throw new Error(`${kind} ${name} needs a namespace.`);
  }
  return `${collectionPath(apiVersion, kind, namespace)}/${encodeURIComponent(name)}`;
}
