import { isUuid } from '@dreamdevops/shared-kernel';
import type { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type { RunningEnvironment, RunningEnvironments } from './running-environments.ts';

interface LiveRow {
  id: string;
  name: string;
  application_id: string;
  production: boolean;
  version: string | null;
  since: Date | null;
  address: string | null;
  target_name: string | null;
  cpu_limit: number | null;
  /** PostgreSQL's bigint arrives as text. */
  memory_limit_bytes: string | null;
}

/** Each environment with the deployment that runs in it, if any, and where. */
const SELECT_LIVE = `
  SELECT e.id, e.name, e.application_id, e.production,
         l.version, l.finished_at AS since, l.address, t.name AS target_name,
         l.cpu_limit, l.memory_limit_bytes
  FROM environments.environments e
  LEFT JOIN environments.deployments l ON l.id = e.live_deployment_id
  LEFT JOIN environments.targets t ON t.id = l.target_id`;

/** What runs in the current company's environments, for other contexts. */
export class LiveEnvironments implements RunningEnvironments {
  readonly #database: TenantDatabase;

  constructor(database: TenantDatabase) {
    this.#database = database;
  }

  async list(): Promise<RunningEnvironment[]> {
    const { rows } = await this.#database.transaction((tx) =>
      tx.query<LiveRow>(
        `${SELECT_LIVE} WHERE e.status = 'active' AND l.id IS NOT NULL ORDER BY e.production, lower(e.name)`,
      ),
    );
    return rows.map(toRunningEnvironment);
  }

  async find(environmentId: string): Promise<RunningEnvironment | null> {
    if (!isUuid(environmentId)) {
      return null;
    }
    const { rows } = await this.#database.transaction((tx) => tx.query<LiveRow>(`${SELECT_LIVE} WHERE e.id = $1`, [environmentId]));
    return rows[0] === undefined ? null : toRunningEnvironment(rows[0]);
  }
}

function toRunningEnvironment(row: LiveRow): RunningEnvironment {
  return {
    environmentId: row.id,
    environmentName: row.name,
    applicationId: row.application_id,
    production: row.production,
    version: row.version,
    since: row.since?.toISOString() ?? null,
    address: row.address,
    targetName: row.target_name,
    limits:
      row.cpu_limit === null || row.memory_limit_bytes === null
        ? null
        : { cpus: row.cpu_limit, memoryBytes: Number(row.memory_limit_bytes) },
  };
}
