import { currentCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { SigningKeys } from '../../builds/application/signing-keys.ts';
import type { SealedBox } from '../../shared/sealed-box.ts';
import { acceptedImageKinds, type EnvironmentKind } from '../domain/environment.ts';
import { EnvironmentError } from '../domain/errors.ts';
import type { EnvironmentRepositories, EnvironmentRepository, PullAccounts, SecretStore } from './ports.ts';
import type { TargetAgents } from './target-agents.ts';

export interface TargetConfigurationOptions {
  /** How targets reach the registry, OpenBao and Git. */
  readonly registryHost: string;
  readonly openbaoUrl: string;
  readonly gitSshUrl: string;
  readonly gitKnownHosts: string;
}

/** Everything a target needs to run its environment, as the agent fetches it. */
export interface TargetConfiguration {
  readonly environment: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly kind: EnvironmentKind;
    readonly acceptedImages: readonly string[];
  };
  /** The company's images, and its read-only account for pulling them. */
  readonly registry: { readonly host: string; readonly organization: string; readonly username: string; readonly token: string };
  /** The only key whose signatures this environment accepts: the release key in production. */
  readonly trustedKey: string;
  /** The environment's repository, which Flux applies with the agent's deploy key. */
  readonly git: { readonly url: string; readonly branch: string; readonly knownHosts: string };
  /** A short-lived token that can only read this environment's secrets. */
  readonly secrets: { readonly url: string; readonly mount: string; readonly path: string; readonly token: string; readonly expiresAt: string };
}

interface EnvironmentRow {
  id: string;
  name: string;
  slug: string;
  kind: EnvironmentKind;
  accepts_feature_images: boolean;
  repository: string | null;
}

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
  readonly #database: TenantDatabase;
  readonly #agents: TargetAgents;
  readonly #repositories: EnvironmentRepositories;
  readonly #pullAccounts: PullAccounts;
  readonly #secrets: SecretStore;
  readonly #signingKeys: SigningKeys;
  readonly #box: SealedBox;
  readonly #options: TargetConfigurationOptions;

  constructor(
    database: TenantDatabase,
    agents: TargetAgents,
    repositories: EnvironmentRepositories,
    pullAccounts: PullAccounts,
    secrets: SecretStore,
    signingKeys: SigningKeys,
    box: SealedBox,
    options: TargetConfigurationOptions,
  ) {
    this.#database = database;
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
      await this.#database.transaction((tx) =>
        tx.query('UPDATE environments.targets SET deploy_key = $2, updated_at = now() WHERE id = $1', [targetId, publicKey]),
      );
    });
  }

  async configuration(accessToken: string | undefined): Promise<TargetConfiguration> {
    const { companyId, environmentId } = await this.#agents.authenticate(accessToken);
    return runWithCompany(companyId, async () => {
      const repository = await this.repositoryOf(environmentId);
      const { environment, trustedKey } = await this.#database.transaction(async (tx) => {
        const row = await findEnvironment(tx, environmentId);
        return {
          environment: row,
          trustedKey: await this.#signingKeys.publicKey(tx, row.kind === 'production' ? 'release' : 'test'),
        };
      });
      const pull = await this.#pullCredentials(repository.organization);
      const path = secretsPath(companyId, environmentId);
      const token = await this.#secrets.issueReadToken(`target-${environmentId}`, path);
      return {
        environment: {
          id: environment.id,
          name: environment.name,
          slug: environment.slug,
          kind: environment.kind,
          acceptedImages: acceptedImageKinds({ kind: environment.kind, acceptsFeatureImages: environment.accepts_feature_images }),
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
      };
    });
  }

  /** The environment's repository, made if missing. Call in the company's context. */
  async repositoryOf(environmentId: string): Promise<EnvironmentRepository> {
    const repository = await this.#database.transaction(async (tx) => {
      const environment = await findEnvironment(tx, environmentId);
      const { rows } = await tx.query<{ slug: string }>('SELECT slug FROM tenancy.companies WHERE id = $1', [
        currentCompanyId(),
      ]);
      const name = environment.repository ?? environmentRepositoryName(environment.slug);
      if (environment.repository === null) {
        await tx.query('UPDATE environments.environments SET repository = $2 WHERE id = $1', [environmentId, name]);
      }
      return { organization: rows[0]!.slug, name, environmentId };
    });
    await this.#repositories.ensure(repository);
    return repository;
  }

  /** The company's pull account, made once. A lock keeps two targets from making it at once. */
  #pullCredentials(organization: string): Promise<{ username: string; token: string }> {
    return this.#database.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('pull-account:' || $1, 0))", [currentCompanyId()]);
      const { rows } = await tx.query<{ username: string; token: string }>(
        'SELECT username, token FROM environments.pull_accounts',
      );
      if (rows[0] !== undefined) {
        return { username: rows[0].username, token: this.#box.open(rows[0].token) };
      }
      const created = await this.#pullAccounts.create(organization);
      await tx.query('INSERT INTO environments.pull_accounts (company_id, username, token) VALUES ($1, $2, $3)', [
        currentCompanyId(),
        created.username,
        this.#box.seal(created.token),
      ]);
      return created;
    });
  }

  /** Removes a disconnected target's deploy key, so it can't read the repository. */
  async removeDeployKey(environmentId: string, targetId: string): Promise<void> {
    const repository = await this.repositoryOf(environmentId);
    await this.#repositories.removeDeployKeys(repository, `target-${targetId}`);
  }
}

async function findEnvironment(tx: TenantTransaction, id: string): Promise<EnvironmentRow> {
  const { rows } = await tx.query<EnvironmentRow>(
    'SELECT id, name, slug, kind, accepts_feature_images, repository FROM environments.environments WHERE id = $1',
    [id],
  );
  if (rows[0] === undefined) {
    throw new EnvironmentError('not-found', 'This environment does not exist.');
  }
  return rows[0];
}
