import type { KubernetesObject } from './kubernetes.ts';
import type { Configuration } from './platform.ts';

/** The agent and the tools it sets up live here. */
export const SYSTEM_NAMESPACE = 'dreamdevops-system';
/** Namespaces the environment repository creates carry this label. */
export const MANAGED_LABEL = 'dreamdevops.io/managed';
export const PULL_SECRET = 'registry-pull';
export const GIT_SECRET = 'dreamdevops-git';
const SECRETS_TOKEN = 'openbao-token';

const secret = (name: string, namespace: string, data: Record<string, string>, type = 'Opaque'): KubernetesObject => ({
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: { name, namespace, labels: { 'app.kubernetes.io/managed-by': 'dreamdevops-agent' } },
  type,
  stringData: data,
});

/** The registry login for the company's images, as Kubernetes reads it. */
export function pullSecret(configuration: Configuration, namespace: string): KubernetesObject {
  const { host, username, token } = configuration.registry;
  const auth = Buffer.from(`${username}:${token}`).toString('base64');
  return secret(
    PULL_SECRET,
    namespace,
    { '.dockerconfigjson': JSON.stringify({ auths: { [host]: { username, password: token, auth } } }) },
    'kubernetes.io/dockerconfigjson',
  );
}

/**
 * What the cluster needs to run the environment: Flux reads the environment repository
 * with the agent's deploy key, Kyverno lets in only images signed with the trusted key,
 * and the External Secrets Operator reads only this environment's secrets.
 */
export function desiredObjects(configuration: Configuration, sshPrivateKey: string): KubernetesObject[] {
  const managedNamespaces = { matchLabels: { [MANAGED_LABEL]: 'true' } };
  return [
    pullSecret(configuration, SYSTEM_NAMESPACE),
    secret(GIT_SECRET, SYSTEM_NAMESPACE, {
      identity: sshPrivateKey,
      known_hosts: configuration.git.knownHosts,
    }),
    {
      apiVersion: 'source.toolkit.fluxcd.io/v1',
      kind: 'GitRepository',
      metadata: { name: 'environment', namespace: SYSTEM_NAMESPACE },
      spec: {
        interval: '1m',
        url: configuration.git.url,
        ref: { branch: configuration.git.branch },
        secretRef: { name: GIT_SECRET },
      },
    },
    {
      apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
      kind: 'Kustomization',
      metadata: { name: 'environment', namespace: SYSTEM_NAMESPACE },
      spec: {
        interval: '1m',
        sourceRef: { kind: 'GitRepository', name: 'environment' },
        path: './',
        prune: true,
        timeout: '5m',
      },
    },
    {
      apiVersion: 'kyverno.io/v1',
      kind: 'ClusterPolicy',
      metadata: {
        name: 'dreamdevops-signed-images',
        annotations: {
          'policies.kyverno.io/description': `Only images signed with the ${configuration.environment.kind === 'production' ? 'release' : 'test'} key of this company run here.`,
        },
      },
      spec: {
        background: false,
        webhookTimeoutSeconds: 30,
        rules: [
          {
            name: 'signed-by-trusted-key',
            match: { any: [{ resources: { kinds: ['Pod'], namespaceSelector: managedNamespaces } }] },
            verifyImages: [
              {
                imageReferences: ['*'],
                failureAction: 'Enforce',
                mutateDigest: true,
                verifyDigest: true,
                required: true,
                imageRegistryCredentials: { secrets: [PULL_SECRET] },
                attestors: [
                  {
                    entries: [
                      {
                        keys: {
                          publicKeys: configuration.trustedKey,
                          // The platform signs; there's no public transparency log to check.
                          rekor: { ignoreTlog: true },
                          ctlog: { ignoreSCT: true },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    secret(SECRETS_TOKEN, SYSTEM_NAMESPACE, { token: configuration.secrets.token }),
    {
      apiVersion: 'external-secrets.io/v1',
      kind: 'ClusterSecretStore',
      metadata: { name: 'dreamdevops' },
      spec: {
        conditions: [{ namespaceSelector: managedNamespaces }],
        provider: {
          vault: {
            server: configuration.secrets.url,
            path: configuration.secrets.mount,
            version: 'v2',
            auth: { tokenSecretRef: { name: SECRETS_TOKEN, key: 'token', namespace: SYSTEM_NAMESPACE } },
          },
        },
      },
    },
  ];
}
