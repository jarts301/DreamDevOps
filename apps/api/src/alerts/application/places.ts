import { DomainError } from '@dreamdevops/shared-kernel';
import { type ApplicationDirectory } from '@dreamdevops/contracts/catalog/services';
import type { EnvironmentDirectory } from '@dreamdevops/contracts/environments/services';
import { placeId } from '@dreamdevops/contracts/environments/telemetry';

/** What an alert watches: one application in one environment, named as people know it. */
export interface Place {
  readonly placeId: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly applicationId: string;
  readonly applicationName: string;
  readonly production: boolean;
}

/** An alert's environment and application. */
export interface PlaceIds {
  readonly environmentId: string;
  readonly applicationId: string;
}

/**
 * Names the places alerts watch, through what EnvironmentDirectory and the catalog publish. Both
 * answer in the current company only, so another company's are never found. A place is
 * named whether or not something runs there now.
 */
export class Places {
  readonly #environments: Pick<EnvironmentDirectory, 'get'>;
  readonly #catalog: Pick<ApplicationDirectory, 'get'>;

  constructor(environments: Pick<EnvironmentDirectory, 'get'>, catalog: Pick<ApplicationDirectory, 'get'>) {
    this.#environments = environments;
    this.#catalog = catalog;
  }

  /** The place, or null when the company has no such environment or application. */
  async find(environmentId: string, applicationId: string): Promise<Place | null> {
    return (await this.of([{ environmentId, applicationId }])).get(placeId(environmentId, applicationId)) ?? null;
  }

  /**
   * Each place the company has, by its ID. Places whose environment or application no
   * longer exists are left out. Any other failure, such as the database being down, is
   * thrown, so it isn't mistaken for a place that's gone.
   */
  async of(rows: readonly PlaceIds[]): Promise<Map<string, Place>> {
    const quietly = <T>(lookup: Promise<T>) =>
      lookup.catch((error: unknown) => {
        if (error instanceof DomainError && error.kind === 'not-found') {
          return null;
        }
        throw error;
      });
    const environments = new Map(
      await Promise.all(
        [...new Set(rows.map((row) => row.environmentId))].map(async (id) => [id, await quietly(this.#environments.get(id))] as const),
      ),
    );
    const applications = new Map(
      await Promise.all(
        [...new Set(rows.map((row) => row.applicationId))].map(async (id) => [id, await quietly(this.#catalog.get(id))] as const),
      ),
    );
    const places = new Map<string, Place>();
    for (const row of rows) {
      const environment = environments.get(row.environmentId);
      const application = applications.get(row.applicationId);
      if (environment === undefined || environment === null || application === undefined || application === null) {
        continue;
      }
      const id = placeId(row.environmentId, row.applicationId);
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
