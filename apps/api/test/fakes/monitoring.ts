import { currentCompanyId } from '@dreamdevops/shared-kernel';
import type { ApplicationView } from '../../src/catalog/application/application-catalog.ts';
import { CatalogError } from '../../src/catalog/domain/errors.ts';
import type { EnvironmentLogLine, EnvironmentLogs } from '../../src/environments/application/environment-logs.ts';
import type { RunningEnvironment, RunningEnvironments } from '../../src/environments/application/running-environments.ts';
import type { MetricKey, MetricValues } from '../../src/monitoring/domain/metrics.ts';
import type { MetricsStore, MetricsWindow, Point, SeriesData, TraceStore } from '../../src/monitoring/application/ports.ts';
import type { StoredTrace } from '../../src/monitoring/domain/traces.ts';

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
    slug: application.name.toLowerCase().replace(/\s+/g, '-'),
    type: { key: 'restful-service', name: 'RESTful Service' },
    blueprint: null,
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
  /** Each environment's highest values in the day before a window. */
  readonly dailyHighs = new Map<string, Partial<Record<MetricKey, number>>>();
  /** The environment IDs of each question, in order. */
  readonly asked: string[][] = [];
  readonly windows: MetricsWindow[] = [];
  /** Thrown by the next question, then cleared. */
  failure: Error | null = null;

  async latest(environmentIds: readonly string[]): Promise<ReadonlyMap<string, MetricValues>> {
    this.#ask(environmentIds);
    return new Map([...this.latestValues].filter(([id]) => environmentIds.includes(id)));
  }

  async series(environmentId: string, window: MetricsWindow): Promise<Readonly<Record<MetricKey, SeriesData>>> {
    this.#ask([environmentId]);
    this.windows.push(window);
    const values = this.seriesValues.get(environmentId) ?? {};
    const highs = this.dailyHighs.get(environmentId) ?? {};
    const of = (key: MetricKey): SeriesData => ({ points: values[key] ?? [], dailyHigh: highs[key] ?? null });
    return { cpu: of('cpu'), memory: of('memory'), requests: of('requests'), responseTime: of('responseTime'), errors: of('errors') };
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

/** What each environment's version wrote, read in the current company only, as the real one does. */
export class FakeEnvironmentLogs implements EnvironmentLogs {
  readonly #environments: FakeRunningEnvironments;
  readonly written = new Map<string, EnvironmentLogLine[]>();
  readonly reads: { environmentId: string; since: Date; limit: number }[] = [];
  /** Thrown by the next read, then cleared. */
  failure: Error | null = null;

  constructor(environments: FakeRunningEnvironments) {
    this.#environments = environments;
  }

  async read(environmentId: string, options: { since: Date; limit: number }): Promise<EnvironmentLogLine[] | null> {
    this.reads.push({ environmentId, ...options });
    const failure = this.failure;
    this.failure = null;
    if (failure !== null) {
      throw failure;
    }
    const environment = await this.#environments.find(environmentId);
    if (environment === null) {
      return null;
    }
    return environment.version === null
      ? []
      : (this.written.get(environmentId) ?? []).filter((line) => line.at >= options.since).slice(-options.limit);
  }
}

/** A trace store in memory, with traces of every company, as a real one has. */
export class FakeTraceStore implements TraceStore {
  readonly traces: StoredTrace[] = [];
  readonly searches: { serviceName: string; start: Date; end: Date; limit: number }[] = [];
  /** Thrown by the next question, then cleared. */
  failure: Error | null = null;

  async recent(serviceName: string, window: { start: Date; end: Date }, limit: number): Promise<StoredTrace[]> {
    this.#fail();
    this.searches.push({ serviceName, ...window, limit });
    return this.traces
      .filter((trace) =>
        trace.spans.some((span) => span.serviceName === serviceName && span.start >= window.start && span.start <= window.end),
      )
      .slice(0, limit);
  }

  async find(traceId: string): Promise<StoredTrace | null> {
    this.#fail();
    return this.traces.find((trace) => trace.traceId === traceId) ?? null;
  }

  #fail(): void {
    const failure = this.failure;
    this.failure = null;
    if (failure !== null) {
      throw failure;
    }
  }
}
