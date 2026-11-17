import type { ApplicationCatalog } from '../../catalog/application/application-catalog.ts';
import type { Environments } from '../../environments/application/environments.ts';
import { placeId } from '../../environments/domain/telemetry.ts';

/** What an alert watches: one application in one environment, named as people know it. */
export interface Place {
  readonly placeId: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly applicationId: string;
  readonly applicationName: string;
  readonly production: boolean;
}

/** An alert's environment and application, as its row keeps them. */
export interface PlaceRow {
  readonly environment_id: string;
  readonly application_id: string;
}

/**
 * Names the places alerts watch, through what Environments and the catalog publish. Both
 * answer in the current company only, so another company's are never found. A place is
 * named whether or not something runs there now.
 */
export class Places {
  readonly #environments: Pick<Environments, 'get'>;
  readonly #catalog: Pick<ApplicationCatalog, 'get'>;

  constructor(environments: Pick<Environments, 'get'>, catalog: Pick<ApplicationCatalog, 'get'>) {
    this.#environments = environments;
    this.#catalog = catalog;
  }

  /** The place, or null when the company has no such environment or application. */
  async find(environmentId: string, applicationId: string): Promise<Place | null> {
    return (await this.of([{ environment_id: environmentId, application_id: applicationId }])).get(placeId(environmentId, applicationId)) ?? null;
  }

  /** Each place the company has, by its ID. Others are left out. */
  async of(rows: readonly PlaceRow[]): Promise<Map<string, Place>> {
    const quietly = <T>(lookup: Promise<T>) => lookup.catch(() => null);
    const environments = new Map(
      await Promise.all(
        [...new Set(rows.map((row) => row.environment_id))].map(async (id) => [id, await quietly(this.#environments.get(id))] as const),
      ),
    );
    const applications = new Map(
      await Promise.all(
        [...new Set(rows.map((row) => row.application_id))].map(async (id) => [id, await quietly(this.#catalog.get(id))] as const),
      ),
    );
    const places = new Map<string, Place>();
    for (const row of rows) {
      const environment = environments.get(row.environment_id);
      const application = applications.get(row.application_id);
      if (environment == null || application == null) {
        continue;
      }
      const id = placeId(row.environment_id, row.application_id);
      places.set(id, {
        placeId: id,
        environmentId: environment.id,
        environmentName: environment.name,
        applicationId: application.id,
        applicationName: application.name,
        production: environment.kind === 'production',
      });
    }
    return places;
  }
}
