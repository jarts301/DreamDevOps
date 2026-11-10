import { readFileSync } from 'node:fs';
import { desiredObjects, GIT_SECRET, MANAGED_LABEL, PULL_SECRET, pullSecret, SYSTEM_NAMESPACE } from './cluster.ts';
import { newKeyPair, newSshKeyPair, sshPublicKeyOf } from './identity.ts';
import { componentObjects } from './components.ts';
import { Kubernetes, KubernetesError, type KubernetesObject } from './kubernetes.ts';
import { type Command, type Configuration, type Identity, Platform, PlatformError } from './platform.ts';
import { deploymentReport, DEPLOYMENT_LABEL, rolloutReport, syncReport } from './reports.ts';

const AGENT_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const IDENTITY_SECRET = 'dreamdevops-agent-identity';
/** The configuration is fetched again this often, and whenever its secrets token is near its end. */
const CONFIGURATION_MS = 30 * 60_000;

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

interface SecretObject {
  readonly data?: Readonly<Record<string, string>>;
}

const decode = (secret: SecretObject | null, key: string): string | undefined => {
  const value = secret?.data?.[key];
  return value === undefined ? undefined : Buffer.from(value, 'base64').toString('utf8');
};

/**
 * The agent's loop. It registers once with the token from the Helm command, then every
 * heartbeat: keeps the cluster set up, reports how deployments are doing, and runs the
 * platform's promote and abort commands.
 */
class Agent {
  readonly #kubernetes = new Kubernetes();
  readonly #platform: Platform;
  #identity: Identity | null = null;
  #configuration: { value: Configuration; fetchedAt: number; complete: boolean } | null = null;
  #heartbeatSeconds = 30;

  constructor(platformUrl: string) {
    this.#platform = new Platform(platformUrl);
  }

  async run(): Promise<never> {
    for (;;) {
      try {
        await this.#step();
      } catch (error) {
        if (error instanceof PlatformError && error.status === 401) {
          // A revoked target stays refused; keep trying slowly, so reconnecting is visible.
          this.#platform.resetToken();
        }
        log(`Step failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.#heartbeatSeconds * 1000));
    }
  }

  async #step(): Promise<void> {
    const identity = await this.#ensureIdentity();
    const sshKey = await this.#ensureDeployKey(identity);
    const configuration = await this.#ensureConfiguration(identity, sshKey);
    await this.#copyPullSecret(configuration);
    const { heartbeatSeconds, commands } = await this.#platform.heartbeat(identity, await this.#report());
    this.#heartbeatSeconds = Math.min(Math.max(heartbeatSeconds, 10), 120);
    for (const command of commands) {
      await this.#run(identity, command);
    }
  }

  /** Loads the agent's key, or registers it with the one-time token from the Helm command. */
  async #ensureIdentity(): Promise<Identity> {
    if (this.#identity !== null) {
      return this.#identity;
    }
    const stored = await this.#kubernetes.get<SecretObject>('v1', 'Secret', IDENTITY_SECRET, SYSTEM_NAMESPACE);
    const targetId = decode(stored, 'targetId');
    const privateKey = decode(stored, 'privateKey');
    if (targetId !== undefined && privateKey !== undefined) {
      this.#identity = { targetId, privateKey };
      return this.#identity;
    }
    const registrationToken = process.env.REGISTRATION_TOKEN;
    if (registrationToken === undefined || registrationToken === '') {
      throw new Error('There is no registration token. Run the command from the dashboard again.');
    }
    const keys = newKeyPair();
    const registration = await this.#platform.register({
      registrationToken,
      publicKey: keys.publicJwk,
      agentVersion: AGENT_VERSION,
      kubernetesVersion: await this.#kubernetes.version(),
    });
    await this.#kubernetes.apply({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: IDENTITY_SECRET, namespace: SYSTEM_NAMESPACE },
      type: 'Opaque',
      stringData: { targetId: registration.targetId, privateKey: keys.privateKey },
    });
    this.#heartbeatSeconds = registration.heartbeatSeconds;
    this.#identity = { targetId: registration.targetId, privateKey: keys.privateKey };
    log(`Registered as target ${registration.targetId}.`);
    return this.#identity;
  }

  /** Makes Flux's SSH key once, and gives the platform its public half. */
  async #ensureDeployKey(identity: Identity): Promise<string> {
    const stored = await this.#kubernetes.get<SecretObject>('v1', 'Secret', GIT_SECRET, SYSTEM_NAMESPACE);
    let privateKey = decode(stored, 'identity');
    if (privateKey === undefined) {
      const keys = newSshKeyPair();
      privateKey = keys.privateKey;
      await this.#kubernetes.apply({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: GIT_SECRET, namespace: SYSTEM_NAMESPACE },
        type: 'Opaque',
        stringData: { identity: privateKey },
      });
      await this.#platform.setDeployKey(identity, keys.publicKey);
      log('Registered the deploy key for the environment repository.');
    } else if (this.#configuration === null) {
      // After a restart, send it again: the platform may have replaced the target's keys.
      await this.#platform.setDeployKey(identity, sshPublicKeyOf(privateKey));
    }
    return privateKey;
  }

  async #ensureConfiguration(identity: Identity, sshKey: string): Promise<Configuration> {
    const current = this.#configuration;
    const fresh =
      current !== null &&
      current.complete &&
      Date.now() - current.fetchedAt < CONFIGURATION_MS &&
      Date.parse(current.value.secrets.expiresAt) - Date.now() > 30 * 60_000;
    if (current !== null && fresh) {
      return current.value;
    }
    const configuration = await this.#platform.configuration(identity);
    // The tools come first. Until Flux has installed them, their own kinds don't exist yet,
    // so those objects wait for a later heartbeat; the agent keeps reporting meanwhile.
    const objects = [
      ...componentObjects({ insecureRegistry: process.env.INSECURE_REGISTRY === 'true' }),
      ...desiredObjects(configuration, sshKey),
    ];
    const waiting: string[] = [];
    for (const object of objects) {
      try {
        await this.#kubernetes.apply(object);
      } catch (error) {
        waiting.push(`${object.kind} ${object.metadata.name}`);
        if (!(error instanceof KubernetesError) || error.status !== 404) {
          log(`Could not apply ${object.kind} ${object.metadata.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    this.#configuration = { value: configuration, fetchedAt: Date.now(), complete: waiting.length === 0 };
    log(
      waiting.length === 0
        ? `Set up the cluster for the ${configuration.environment.kind} environment ${configuration.environment.name}.`
        : `Waiting for the tools to install before applying: ${waiting.join(', ')}.`,
    );
    return configuration;
  }

  /** Each namespace the environment repository makes needs the registry login. */
  async #copyPullSecret(configuration: Configuration): Promise<void> {
    // Written to new namespaces, and to all of them right after the login may have changed.
    const justFetched = Date.now() - (this.#configuration?.fetchedAt ?? 0) < 60_000;
    const namespaces = await this.#kubernetes.list<KubernetesObject>('v1', 'Namespace', `${MANAGED_LABEL}=true`);
    for (const namespace of namespaces) {
      const existing = await this.#kubernetes.get<SecretObject>('v1', 'Secret', PULL_SECRET, namespace.metadata.name);
      if (existing === null || justFetched) {
        await this.#kubernetes.apply(pullSecret(configuration, namespace.metadata.name));
      }
    }
  }

  async #report() {
    const rollouts = await this.#kubernetes.list<Parameters<typeof rolloutReport>[0]>('argoproj.io/v1alpha1', 'Rollout', DEPLOYMENT_LABEL);
    const deployments = await this.#kubernetes.list<Parameters<typeof deploymentReport>[0]>('apps/v1', 'Deployment', DEPLOYMENT_LABEL);
    const kustomization = await this.#kubernetes.get<Parameters<typeof syncReport>[0]>(
      'kustomize.toolkit.fluxcd.io/v1',
      'Kustomization',
      'environment',
      SYSTEM_NAMESPACE,
    );
    return {
      agentVersion: AGENT_VERSION,
      kubernetesVersion: await this.#kubernetes.version(),
      sync: syncReport(kustomization),
      workloads: [...rollouts.map(rolloutReport), ...deployments.map(deploymentReport)].filter((report) => report !== null),
    };
  }

  /** Promotes a waiting blue/green rollout, or aborts one, returning traffic to the stable version. */
  async #run(identity: Identity, command: Command): Promise<void> {
    try {
      if (command.action === 'promote') {
        await this.#kubernetes.patch('argoproj.io/v1alpha1', 'Rollout', command.name, command.namespace, { spec: { paused: false } });
        await this.#kubernetes.patch('argoproj.io/v1alpha1', 'Rollout', command.name, command.namespace, { status: { pauseConditions: null } }, 'status');
      } else {
        await this.#kubernetes.patch('argoproj.io/v1alpha1', 'Rollout', command.name, command.namespace, { status: { abort: true } }, 'status');
      }
      await this.#platform.commandDone(identity, command.id, { succeeded: true, message: null });
      log(`Ran ${command.action} on ${command.namespace}/${command.name}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : 'The command failed.';
      await this.#platform.commandDone(identity, command.id, { succeeded: false, message });
    }
  }
}

const platformUrl = process.env.PLATFORM_URL;
if (platformUrl === undefined || platformUrl === '') {
  throw new Error('PLATFORM_URL is not set.');
}
log(`DreamDevOps agent ${AGENT_VERSION} starting.`);
await new Agent(platformUrl).run();
