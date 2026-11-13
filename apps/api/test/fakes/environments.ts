import { randomBytes } from 'node:crypto';
import type {
  EnvironmentRepositories,
  EnvironmentRepository,
  FileChange,
  PullAccounts,
  PullCredentials,
  SecretStore,
} from '../../src/environments/application/ports.ts';

/** Environment repositories kept in memory, with each commit's files. */
export class FakeEnvironmentRepositories implements EnvironmentRepositories {
  readonly repositories = new Map<string, Map<string, string>>();
  readonly deployKeys = new Map<string, { title: string; key: string }[]>();
  readonly commits: { repository: string; sha: string; message: string; files: Map<string, string> }[] = [];

  async ensure(repository: EnvironmentRepository): Promise<void> {
    const name = `${repository.organization}/${repository.name}`;
    if (!this.repositories.has(name)) {
      this.repositories.set(name, new Map([['README.md', `# ${repository.name}\n`]]));
    }
  }

  async setDeployKey(repository: EnvironmentRepository, title: string, publicKey: string): Promise<void> {
    this.deployKeys.set(`${repository.organization}/${repository.name}`, [{ title, key: publicKey }]);
  }

  async removeDeployKeys(repository: EnvironmentRepository, title?: string): Promise<void> {
    const name = `${repository.organization}/${repository.name}`;
    this.deployKeys.set(name, (this.deployKeys.get(name) ?? []).filter((key) => title !== undefined && key.title !== title));
  }

  async readFolder(repository: EnvironmentRepository, folder: string): Promise<Map<string, string>> {
    const files = this.repositories.get(`${repository.organization}/${repository.name}`) ?? new Map<string, string>();
    return new Map([...files].filter(([path]) => path === folder || path.startsWith(`${folder}/`)));
  }

  async commit(repository: EnvironmentRepository, message: string, changes: readonly FileChange[]): Promise<string> {
    const name = `${repository.organization}/${repository.name}`;
    const files = this.repositories.get(name) ?? new Map<string, string>();
    for (const change of changes) {
      if (change.content === null) {
        files.delete(change.path);
      } else {
        files.set(change.path, change.content);
      }
    }
    this.repositories.set(name, files);
    const sha = randomBytes(20).toString('hex');
    this.commits.push({ repository: name, sha, message, files: new Map(files) });
    return sha;
  }

  /** The files of an environment repository, as they are now. */
  files(organization: string, name: string): Map<string, string> {
    return this.repositories.get(`${organization}/${name}`) ?? new Map();
  }
}

export class FakePullAccounts implements PullAccounts {
  readonly created: string[] = [];

  async create(organization: string): Promise<PullCredentials> {
    this.created.push(organization);
    return { username: `${organization}-pull`, token: `pull-token-${this.created.length}` };
  }
}

/** Keeps secret values, so tests can check what reached the store. */
export class FakeSecretStore implements SecretStore {
  readonly values = new Map<string, Record<string, string>>();
  readonly tokens: { policyName: string; path: string }[] = [];

  async write(path: string, values: Readonly<Record<string, string>>): Promise<void> {
    this.values.set(path, { ...(this.values.get(path) ?? {}), ...values });
  }

  async remove(path: string, names: readonly string[]): Promise<void> {
    const current = { ...(this.values.get(path) ?? {}) };
    for (const name of names) {
      delete current[name];
    }
    this.values.set(path, current);
  }

  async issueReadToken(policyName: string, path: string): Promise<{ token: string; expiresAt: Date }> {
    this.tokens.push({ policyName, path });
    return { token: `read-token-${this.tokens.length}`, expiresAt: new Date(Date.now() + 2 * 3_600_000) };
  }

  async renew(): Promise<void> {}
}
