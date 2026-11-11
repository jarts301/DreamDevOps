import { ChangeDetectionStrategy, Component, inject, type OnDestroy, type OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../core/api-error';
import { PageActivity } from '../../core/page-activity';
import { LogView } from './log-view';
import { MetricChart } from './metric-chart';
import { formatLimit, formatMetric, NEAR_LIMIT, shareOfLimit } from './metric-format';
import {
  type ContainerLimits,
  type EnvironmentLogs,
  type EnvironmentMetrics,
  type EnvironmentTraces,
  type MetricKey,
  type MetricUnit,
  type MetricValues,
  MonitoringApi,
  type MonitoredEnvironment,
  type MonitoringOverview,
  type TimeRangeKey,
  type Trace,
} from './monitoring.api';
import { TraceList } from './trace-list';
import { TraceView } from './trace-view';

/** How often the page reads everything on it again while it's open. */
export const REFRESH_MS = 30_000;

const RANGES: readonly { readonly key: TimeRangeKey; readonly label: string }[] = [
  { key: '15m', label: 'Last 15 minutes' },
  { key: '1h', label: 'Last hour' },
  { key: '6h', label: 'Last 6 hours' },
  { key: '24h', label: 'Last 24 hours' },
];

/**
 * Something the page reads, with why it couldn't, if it couldn't. Answers are counted, so
 * an older one that arrives late never replaces a newer one.
 */
class Loaded<T> {
  readonly value = signal<T | null>(null);
  readonly error = signal<string | null>(null);
  #request = 0;

  clear(): void {
    this.#request += 1;
    this.value.set(null);
    this.error.set(null);
  }

  /** Reads it again. What's on screen stays until the new answer arrives. */
  async load(read: () => Promise<T>): Promise<void> {
    const request = ++this.#request;
    try {
      const value = await read();
      if (request === this.#request) {
        this.value.set(value);
        this.error.set(null);
      }
    } catch (error) {
      if (request === this.#request) {
        this.error.set(errorMessage(error));
      }
    }
  }
}

/**
 * How the versions that run in the company's environments are doing: CPU, memory,
 * requests, response times and server errors, what they write, and the traces of the
 * requests they answer. Every member who views dashboards can see it, and nothing here
 * changes anything.
 */
@Component({
  selector: 'app-monitoring',
  imports: [LogView, MetricChart, RouterLink, TraceList, TraceView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Monitoring</h1>
    <p class="lead">
      How the versions that run in your environments are doing: their CPU, memory, requests, response times and
      server errors, what they write to their logs, and the traces of the requests they answer.
    </p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }

    @if (loading()) {
      <p class="muted">Loading…</p>
    } @else if (overview(); as current) {
      @if (!current.enabled) {
        <p class="alert alert-info" role="status">
          This server doesn't keep applications' metrics yet, so none are shown. An administrator can set it up.
        </p>
      }
      @if (current.problem; as problem) {
        <p class="alert alert-error" role="alert">{{ problem }}</p>
      }

      @if (current.environments.length === 0) {
        <p class="empty-state">
          Nothing runs in your environments yet. Deploy a version on the
          <a routerLink="/environments">Environments</a> page, and its metrics show here.
        </p>
      } @else {
        <section class="card" aria-labelledby="running-heading">
          <h2 id="running-heading">Running now</h2>
          <div class="table-scroll">
            <table class="monitoring-table">
              <thead>
                <tr>
                  <th scope="col">Application</th>
                  <th scope="col">Environment</th>
                  @for (metric of current.metrics; track metric.key) {
                    <th scope="col" class="metric-value">{{ metric.name }}</th>
                  }
                  <th scope="col"><span class="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (row of current.environments; track row.environmentId) {
                  @let open = selected()?.environmentId === row.environmentId;
                  <tr [attr.data-production]="row.production">
                    <td>{{ row.applicationName }}</td>
                    <td>
                      {{ row.environmentName }}
                      @if (row.production) {
                        <span class="status" data-tone="production">Production</span>
                      }
                      <p class="cell-note">
                        {{ row.version }}
                        @if (row.targetName) {
                          on {{ row.targetName }}
                        }
                      </p>
                      @if (current.enabled && current.problem === null && sendsNothing(row.latest)) {
                        <p class="cell-note">No metrics received yet.</p>
                      }
                    </td>
                    @for (metric of current.metrics; track metric.key) {
                      <td class="metric-value" [class.muted]="row.latest[metric.key] === null">
                        {{ format(row.latest[metric.key], metric.unit) }}
                        @if (limitNote(row.latest[metric.key], metric.key, row.limits); as note) {
                          <p class="cell-note" [attr.data-tone]="note.near ? 'danger' : null">{{ note.text }}</p>
                        }
                      </td>
                    }
                    <td class="cell-actions">
                      <button
                        type="button"
                        class="button"
                        [attr.aria-expanded]="open"
                        [attr.aria-label]="(open ? 'Hide details of ' : 'Show details of ') + row.applicationName + ' in ' + row.environmentName"
                        (click)="toggle(row)"
                      >
                        {{ open ? 'Hide details' : 'Show details' }}
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="cell-note">
            Values from the last two minutes. Response time is the time within which 95% of requests are answered. The
            page refreshes every 30 seconds.
          </p>
        </section>

        @if (selected(); as chosen) {
          <section class="card" aria-labelledby="details-heading">
            <div class="monitoring-charts-header">
              <h2 id="details-heading">{{ chosen.applicationName }} in {{ chosen.environmentName }}</h2>
              <label class="field-inline">
                <span>Range</span>
                <select [value]="range()" (change)="chooseRange($event)">
                  @for (option of ranges; track option.key) {
                    <option [value]="option.key" [selected]="option.key === range()">{{ option.label }}</option>
                  }
                </select>
              </label>
            </div>

            <p class="cell-note">
              @if (chosen.limits) {
                Its container may use at most {{ limitText('cpu', chosen.limits) }} and {{ limitText('memory', chosen.limits) }} of
                memory{{ chosen.targetName ? ', on ' + chosen.targetName : '' }}.
              } @else {
                Its container's limits aren't known.
              }
            </p>

            <h3 id="metrics-heading">Metrics</h3>
            @if (!current.enabled) {
              <p class="muted">This server doesn't keep metrics yet.</p>
            } @else if (charts.error(); as message) {
              <p class="alert alert-error" role="alert">{{ message }}</p>
            } @else if (charts.value(); as metrics) {
              <div class="metric-grid">
                @for (series of metrics.series; track series.key) {
                  <app-metric-chart
                    [series]="series"
                    [start]="metrics.range.start"
                    [end]="metrics.range.end"
                    [stepSeconds]="metrics.range.stepSeconds"
                    [limit]="limitText(series.key, chosen.limits)"
                  />
                }
              </div>
            } @else {
              <p class="muted">Loading…</p>
            }

            <h3 id="logs-heading">Logs</h3>
            @if (logs.error(); as message) {
              <p class="alert alert-error" role="alert">{{ message }}</p>
            } @else if (logs.value(); as written) {
              <app-log-view
                [lines]="written.lines"
                [emptyMessage]="written.running ? 'Nothing was written in this range.' : 'Nothing runs here, so nothing is written.'"
                (openTrace)="openTrace($event)"
              />
            } @else {
              <p class="muted">Loading…</p>
            }

            <h3 id="traces-heading">Traces</h3>
            @if (traces.error(); as message) {
              <p class="alert alert-error" role="alert">{{ message }}</p>
            } @else if (traces.value(); as found) {
              @if (found.enabled) {
                <app-trace-list [traces]="found.traces" (open)="openTrace($event)" />
              } @else {
                <p class="muted">This server doesn't keep traces yet.</p>
              }
            } @else {
              <p class="muted">Loading…</p>
            }
          </section>
        }

        @if (traceId(); as id) {
          <section class="card" aria-labelledby="trace-heading">
            <div class="monitoring-charts-header">
              <h2 id="trace-heading">Trace <code>{{ id }}</code></h2>
              <button type="button" class="button" (click)="closeTrace()">Close trace</button>
            </div>
            @if (trace.error(); as message) {
              <p class="alert alert-error" role="alert">{{ message }}</p>
            } @else if (trace.value(); as shown) {
              <app-trace-view [trace]="shown" />
            } @else {
              <p class="muted">Loading…</p>
            }
          </section>
        }
      }
    }
  `,
})
export class Monitoring implements OnInit, OnDestroy {
  readonly #api = inject(MonitoringApi);
  readonly #activity = new PageActivity('no-notice');
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #destroyed = false;

  protected readonly ranges = RANGES;
  protected readonly error = this.#activity.error;
  protected readonly loading = signal(true);
  protected readonly overview = signal<MonitoringOverview | null>(null);
  protected readonly selected = signal<MonitoredEnvironment | null>(null);
  protected readonly range = signal<TimeRangeKey>('1h');
  protected readonly charts = new Loaded<EnvironmentMetrics>();
  protected readonly logs = new Loaded<EnvironmentLogs>();
  protected readonly traces = new Loaded<EnvironmentTraces>();
  /** The trace opened from a log line or the list of traces, if one is. */
  protected readonly traceId = signal<string | null>(null);
  protected readonly trace = new Loaded<Trace>();

  async ngOnInit(): Promise<void> {
    await this.#activity.run(() => this.#loadOverview());
    this.loading.set(false);
    this.#scheduleRefresh();
  }

  ngOnDestroy(): void {
    this.#destroyed = true;
    clearTimeout(this.#refreshTimer);
  }

  protected format(value: number | null, unit: MetricUnit): string {
    return formatMetric(value, unit);
  }

  protected limitText(key: MetricKey, limits: ContainerLimits | null): string | null {
    return formatLimit(key, limits);
  }

  /** What a value is measured against, such as "of 512 MiB, 10%", and whether it's close to it. */
  protected limitNote(value: number | null, key: MetricKey, limits: ContainerLimits | null): { text: string; near: boolean } | null {
    const limit = formatLimit(key, limits);
    if (limit === null) {
      return null;
    }
    const share = shareOfLimit(value, key, limits);
    if (share === null) {
      return { text: `Limit: ${limit}`, near: false };
    }
    // CPU is already a share, of one core, so its percentage says how close it is.
    const text = key === 'memory' ? `of ${limit}, ${Math.round(share * 100)}%` : `of ${limit}`;
    return { text, near: share >= NEAR_LIMIT };
  }

  protected sendsNothing(latest: MetricValues): boolean {
    return Object.values(latest).every((value) => value === null);
  }

  protected async toggle(environment: MonitoredEnvironment): Promise<void> {
    for (const loaded of [this.charts, this.logs, this.traces]) {
      loaded.clear();
    }
    if (this.selected()?.environmentId === environment.environmentId) {
      this.selected.set(null);
      return;
    }
    this.selected.set(environment);
    await this.#loadDetails();
  }

  protected async chooseRange(event: Event): Promise<void> {
    this.range.set((event.target as HTMLSelectElement).value as TimeRangeKey);
    for (const loaded of [this.charts, this.logs, this.traces]) {
      loaded.clear();
    }
    await this.#loadDetails();
  }

  protected async openTrace(traceId: string): Promise<void> {
    this.traceId.set(traceId);
    this.trace.clear();
    await this.trace.load(() => this.#api.trace(traceId));
  }

  protected closeTrace(): void {
    this.traceId.set(null);
    this.trace.clear();
  }

  async #loadOverview(): Promise<void> {
    this.overview.set(await this.#api.overview());
  }

  /** The chosen environment's metrics, logs and traces, side by side. */
  async #loadDetails(): Promise<void> {
    const environment = this.selected();
    if (environment === null) {
      return;
    }
    const id = environment.environmentId;
    const range = this.range();
    await Promise.all([
      this.overview()?.enabled ? this.charts.load(() => this.#api.environment(id, range)) : Promise.resolve(),
      this.logs.load(() => this.#api.logs(id, range)),
      this.traces.load(() => this.#api.traces(id, range)),
    ]);
  }

  /** Reads everything on the page again every so often, while it's open. An open trace doesn't change, so it stays. */
  #scheduleRefresh(): void {
    if (this.#destroyed) {
      return;
    }
    this.#refreshTimer = setTimeout(async () => {
      await this.#activity.run(() => this.#loadOverview());
      await this.#loadDetails();
      this.#scheduleRefresh();
    }, REFRESH_MS);
  }
}
