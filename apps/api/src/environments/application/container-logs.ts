import { describeError, isUuid } from '@dreamdevops/shared-kernel';
import type { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type { ApplicationCatalog } from '../../catalog/application/application-catalog.ts';
import { containerName } from '../domain/deployment.ts';
import type { HostingSettings } from '../domain/hosting-providers.ts';
import { type EnvironmentLogLine, type EnvironmentLogs, LogsUnavailableError } from './environment-logs.ts';
import type { HostRuntimes } from './ports.ts';

interface LiveContainerRow {
  slug: string;
  application_id: string;
  live_deployment_id: string | null;
  target_id: string | null;
  target_name: string | null;
  provider: string | null;
  settings: HostingSettings | null;
}

/**
 * Reads what the version in an environment writes from its container, on the host it runs
 * on, whichever target that is. Applications need nothing to be read: every line they
 * write to their output counts.
 */
export class ContainerLogs implements EnvironmentLogs {
  readonly #database: TenantDatabase;
  readonly #catalog: ApplicationCatalog;
  readonly #runtimes: HostRuntimes;

  constructor(database: TenantDatabase, catalog: ApplicationCatalog, runtimes: HostRuntimes) {
    this.#database = database;
    this.#catalog = catalog;
    this.#runtimes = runtimes;
  }

  async read(environmentId: string, options: { readonly since: Date; readonly limit: number }): Promise<EnvironmentLogLine[] | null> {
    if (!isUuid(environmentId)) {
      return null;
    }
    const { rows } = await this.#database.transaction((tx) =>
      tx.query<LiveContainerRow>(
        `SELECT e.slug, e.application_id, e.live_deployment_id,
                t.id AS target_id, t.name AS target_name, t.provider, t.settings
         FROM environments.environments e
         LEFT JOIN environments.deployments l ON l.id = e.live_deployment_id
         LEFT JOIN environments.targets t ON t.id = l.target_id
         WHERE e.id = $1`,
        [environmentId],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const runtime = row.provider === null ? null : this.#runtimes.find(row.provider);
    if (row.live_deployment_id === null || row.target_id === null || runtime === null) {
      return [];
    }
    const application = await this.#catalog.get(row.application_id);
    try {
      return await runtime.logs(
        { id: row.target_id, name: row.target_name!, provider: row.provider!, settings: row.settings ?? {} },
        containerName(application.slug, row.slug, environmentId),
        options,
      );
    } catch (error) {
      throw new LogsUnavailableError(`The logs can’t be read from ${row.target_name} right now. ${describeError(error)}`);
    }
  }
}
