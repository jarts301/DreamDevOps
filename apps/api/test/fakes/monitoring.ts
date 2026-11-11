import { currentCompanyId } from '@dreamdevops/shared-kernel';
import type { ApplicationView } from '../../src/catalog/application/application-catalog.ts';
import { CatalogError } from '../../src/catalog/domain/errors.ts';
import type { RunningEnvironment, RunningEnvironments } from '../../src/environments/application/running-environments.ts';
import type { MetricKey, MetricValues } from '../../src/monitoring/domain/metrics.ts';
import type { MetricsStore, MetricsWindow, Point } from '../../src/monitoring/application/ports.ts';

/** Environments by company, answered in the current company only, as the real one does. */
export class FakeRunningEnvironments implements RunningEnvironments {
  readonly byCompany = new Map<string, RunningEnvironment[]>();

  async list(): Promise<RunningEnvironment[]> {
    return (this.byCompany.get(currentCompanyId()) ?? []).filter((environment) => environment.version !== null);
  }

  async find(environmentId: string): Promise<RunningEnvironment | null> {
    return (this.byCompany.get(currentCompanyId()) ?? []).find((environment) => environment.environmentId === environmentId) ?? null;
  }
}

/** The part of the application catalog other contexts use, by company. */
export class FakeApplicationCatalog {
  readonly byCompany = new Map<string, { id: string; name: string; status: 'active' | 'archived' }[]>();

  async list(status: unknown): Promise<ApplicationView[]> {
    return this.#mine()
      .filter((application) => application.status === (status ?? 'active'))
      .map(toView);
  }

  async get(id: unknown): Promise<ApplicationView> {
    const application = this.#mine().find((candidate) => candidate.id === id);
    if (application === undefined) {
      throw new CatalogError('not-found', 'There’s no such application.');
    }
    return toView(application);
  }

  #mine() {
    return this.byCompany.get(currentCompanyId()) ?? [];
  }
}

function toView(application: { id: string; name: string; status: 'active' | 'archived' }): ApplicationView {
  return {
    id: application.id,
    name: application.name,
    slug: application.name.toLowerCase(),
    type: { key: 'restful-service', name: 'RESTful Service' },
    description: '',
    status: application.status,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: null,
    archivedAt: null,
  };
}

/** A metrics store in memory, which remembers what it was asked about. */
export class FakeMetricsStore implements MetricsStore {
  readonly latestValues = new Map<string, MetricValues>();
  readonly seriesValues = new Map<string, Partial<Record<MetricKey, Point[]>>>();
  /** The environment IDs of each question, in order. */
  readonly asked: string[][] = [];
  readonly windows: MetricsWindow[] = [];
  /** Thrown by the next question, then cleared. */
  failure: Error | null = null;

  async latest(environmentIds: readonly string[]): Promise<ReadonlyMap<string, MetricValues>> {
    this.#ask(environmentIds);
    return new Map([...this.latestValues].filter(([id]) => environmentIds.includes(id)));
  }

  async series(environmentId: string, window: MetricsWindow): Promise<Readonly<Record<MetricKey, readonly Point[]>>> {
    this.#ask([environmentId]);
    this.windows.push(window);
    const values = this.seriesValues.get(environmentId) ?? {};
    return {
      cpu: values.cpu ?? [],
      memory: values.memory ?? [],
      requests: values.requests ?? [],
      responseTime: values.responseTime ?? [],
      errors: values.errors ?? [],
    };
  }

  #ask(environmentIds: readonly string[]): void {
    this.asked.push([...environmentIds]);
    const failure = this.failure;
    this.failure = null;
    if (failure !== null) {
      throw failure;
    }
  }
}
