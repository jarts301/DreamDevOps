import type { ApplicationCatalog } from '../../catalog/application/application-catalog.ts';
import type { RunningEnvironments } from '../../environments/application/running-environments.ts';

/** The environment an alert watches, named as people know it. */
export interface Place {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly applicationId: string;
  readonly applicationName: string;
  readonly production: boolean;
}

/**
 * Names the environments alerts watch, and their applications, through what Environments
 * and the catalog publish. Both answer in the current company only.
 */
export class Places {
  readonly #environments: RunningEnvironments;
  readonly #catalog: Pick<ApplicationCatalog, 'get'>;

  constructor(environments: RunningEnvironments, catalog: Pick<ApplicationCatalog, 'get'>) {
    this.#environments = environments;
    this.#catalog = catalog;
  }

  /** The environment, or null when the company has no such environment. */
  async find(environmentId: string): Promise<Place | null> {
    return (await this.of([environmentId])).get(environmentId) ?? null;
  }

  /** Each environment the company has, by ID. Others are left out. */
  async of(environmentIds: readonly string[]): Promise<Map<string, Place>> {
    const environments = (
      await Promise.all([...new Set(environmentIds)].map((id) => this.#environments.find(id)))
    ).filter((environment) => environment !== null);
    const applicationIds = [...new Set(environments.map((environment) => environment.applicationId))];
    const names = new Map(
      await Promise.all(
        applicationIds.map(async (id) => [id, (await this.#catalog.get(id)).name] as const),
      ),
    );
    return new Map(
      environments.map((environment) => [
        environment.environmentId,
        {
          environmentId: environment.environmentId,
          environmentName: environment.environmentName,
          applicationId: environment.applicationId,
          applicationName: names.get(environment.applicationId) ?? '',
          production: environment.production,
        },
      ]),
    );
  }
}
