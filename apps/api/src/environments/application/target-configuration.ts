import type { TargetConfiguration } from '@dreamdevops/contracts/agent/protocol';
import { currentCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import type { ImageSigningKeys } from '@dreamdevops/contracts/builds/services';
import type { CompanyDirectory } from '@dreamdevops/contracts/tenancy/services';
import type { SealedBox } from '../../shared/sealed-box.ts';
import { acceptedImageKinds } from '../domain/environment.ts';
import { EnvironmentError } from '../domain/errors.ts';
import type {
  EnvironmentRepositories,
  EnvironmentRepository,
  EnvironmentsSession,
  EnvironmentsStore,
  PullAccounts,
  SecretStore,
  StoredEnvironment,
} from './ports.ts';
import type { TargetAgents } from './target-agents.ts';

export interface TargetConfigurationOptions {
  /** How targets reach the registry, OpenBao and Git. */
  readonly registryHost: string;
  readonly openbaoUrl: string;
  readonly gitSshUrl: string;
  readonly gitKnownHosts: string;
  /** Where agents reach the API, which takes their telemetry too. */
  readonly agentApiUrl: string;
}

// What a target needs is the agent protocol, kept in the contracts.
export type { TargetConfiguration } from '@dreamdevops/contracts/agent/protocol';

const DEPLOY_KEY = /^ssh-ed25519 [A-Za-z0-9+/=]{60,100}$/;

/** The secrets of an environment live under this path in the secret store. */
export function secretsPath(companyId: string, environmentId: string): string {
  return `${companyId}/${environmentId}`;
}

/** The name of an environment's repository in the company's organization. */
export function environmentRepositoryName(slug: string): string {
  return `environment-${slug}`;
}

/**
 * Gives an agent what its target needs, after it proves itself with its access token:
 * where its manifests are, the key it may trust, how to pull images and how to read its
 * secrets. Nothing here reaches another environment.
 */
export class TargetConfigurations {
  readonly #store: EnvironmentsStore;
  readonly #companies: CompanyDirectory;
  readonly #agents: TargetAgents;
  readonly #repositories: EnvironmentRepositories;
  readonly #pullAccounts: PullAccounts;
  readonly #secrets: SecretStore;
  readonly #signingKeys: ImageSigningKeys;
  readonly #box: SealedBox;
  readonly #options: TargetConfigurationOptions;

  constructor(
    store: EnvironmentsStore,
    companies: CompanyDirectory,
    agents: TargetAgents,
    repositories: EnvironmentRepositories,
    pullAccounts: PullAccounts,
    secrets: SecretStore,
    signingKeys: ImageSigningKeys,
    box: SealedBox,
    options: TargetConfigurationOptions,
  ) {
    this.#store = store;
    this.#companies = companies;
    this.#agents = agents;
    this.#repositories = repositories;
    this.#pullAccounts = pullAccounts;
    this.#secrets = secrets;
    this.#signingKeys = signingKeys;
    this.#box = box;
    this.#options = options;
  }

  /** The agent sends the public half of the SSH key it made for Flux. */
  async setDeployKey(accessToken: string | undefined, input: { publicKey?: unknown }): Promise<void> {
    const publicKey = typeof input.publicKey === 'string' ? input.publicKey.trim().split(/\s+/).slice(0, 2).join(' ') : '';
    if (!DEPLOY_KEY.test(publicKey)) {
      throw new EnvironmentError('invalid', 'Send an ssh-ed25519 public key.');
    }
    const { companyId, targetId, environmentId } = await this.#agents.authenticate(accessToken);
    await runWithCompany(companyId, async () => {
      const repository = await this.repositoryOf(environmentId);
      await this.#repositories.setDeployKey(repository, `target-${targetId}`, publicKey);
      await this.#store.transaction((session) => session.setDeployKey(targetId, publicKey));
    });
  }

  async configuration(accessToken: string | undefined): Promise<TargetConfiguration> {
    const { companyId, environmentId, targetId } = await this.#agents.authenticate(accessToken);
    return runWithCompany(companyId, async () => {
      const repository = await this.repositoryOf(environmentId);
      const environment = await this.#store.transaction((session) => findEnvironment(session, environmentId));
      // Builds' key, asked for once this context's transaction has ended.
      const trustedKey = await this.#signingKeys.publicKey(environment.kind === 'production' ? 'release' : 'test');
      const pull = await this.#pullCredentials(repository.organization);
      const path = secretsPath(companyId, environmentId);
      const token = await this.#secrets.issueReadToken(`target-${environmentId}`, path);
      const telemetry = this.#agents.issueTelemetryToken(targetId);
      return {
        environment: {
          id: environment.id,
          name: environment.name,
          slug: environment.slug,
          kind: environment.kind,
          acceptedImages: acceptedImageKinds({ kind: environment.kind, acceptsFeatureImages: environment.acceptsFeatureImages }),
        },
        registry: { host: this.#options.registryHost, organization: repository.organization, ...pull },
        trustedKey,
        git: {
          url: `${this.#options.gitSshUrl.replace(/\/$/, '')}/${repository.organization}/${repository.name}.git`,
          branch: 'main',
          knownHosts: this.#options.gitKnownHosts,
        },
        secrets: {
          url: this.#options.openbaoUrl,
          mount: 'dreamdevops',
          path,
          token: token.token,
          expiresAt: token.expiresAt.toISOString(),
        },
        telemetry: {
          endpoint: `${this.#options.agentApiUrl.replace(/\/$/, '')}/api/v1/telemetry`,
          token: telemetry.token,
          expiresAt: telemetry.expiresAt.toISOString(),
        },
      };
    });
  }

  /** The environment's repository, made if missing. Call in the company's context. */
  async repositoryOf(environmentId: string): Promise<EnvironmentRepository> {
    // The company's Git organization is named by its short name, which Tenancy knows.
    const company = await this.#companies.find(currentCompanyId());
    const repository = await this.#store.transaction(async (session) => {
      const environment = await findEnvironment(session, environmentId);
      const name = environment.repository ?? environmentRepositoryName(environment.slug);
      if (environment.repository === null) {
        await session.setRepository(environmentId, name);
      }
      return { organization: company!.slug, name, environmentId };
    });
    await this.#repositories.ensure(repository);
    return repository;
  }

  /** The company's pull account, made once. A lock keeps two targets from making it at once. */
  #pullCredentials(organization: string): Promise<{ username: string; token: string }> {
    return this.#store.transaction(async (session) => {
      await session.lockPullAccount();
      const existing = await session.pullAccount();
      if (existing !== null) {
        return { username: existing.username, token: this.#box.open(existing.sealedToken) };
      }
      const created = await this.#pullAccounts.create(organization);
      await session.addPullAccount(created.username, this.#box.seal(created.token));
      return created;
    });
  }

  /** Removes a disconnected target's deploy key, so it can't read the repository. */
  async removeDeployKey(environmentId: string, targetId: string): Promise<void> {
    const repository = await this.repositoryOf(environmentId);
    await this.#repositories.removeDeployKeys(repository, `target-${targetId}`);
  }
}

async function findEnvironment(session: EnvironmentsSession, id: string): Promise<StoredEnvironment> {
  const environment = await session.findEnvironment(id);
  if (environment === null) {
    throw new EnvironmentError('not-found', 'This environment does not exist.');
  }
  return environment;
}
