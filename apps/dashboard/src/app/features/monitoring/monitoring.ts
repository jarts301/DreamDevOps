import { ChangeDetectionStrategy, Component, inject, type OnDestroy, type OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../core/api-error';
import { PageActivity } from '../../core/page-activity';
import { MetricChart } from './metric-chart';
import { formatMetric } from './metric-format';
import {
  type EnvironmentMetrics,
  type MetricUnit,
  type MetricValues,
  MonitoringApi,
  type MonitoredEnvironment,
  type MonitoringOverview,
  type TimeRangeKey,
} from './monitoring.api';

/** How often the page reads the metrics again while it's open. */
export const REFRESH_MS = 30_000;

const RANGES: readonly { readonly key: TimeRangeKey; readonly label: string }[] = [
  { key: '15m', label: 'Last 15 minutes' },
  { key: '1h', label: 'Last hour' },
  { key: '6h', label: 'Last 6 hours' },
  { key: '24h', label: 'Last 24 hours' },
];

/**
 * How the versions that run in the company's environments are doing: CPU, memory,
 * requests, response times and server errors, as the applications send them. Every
 * member who views dashboards can see it, and nothing here changes anything.
 */
@Component({
  selector: 'app-monitoring',
  imports: [MetricChart, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Monitoring</h1>
    <p class="lead">
      How the versions that run in your environments are doing: their CPU, memory, requests, response times and
      server errors, as the applications send them.
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
                  @if (current.enabled) {
                    <th scope="col"><span class="visually-hidden">Actions</span></th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (row of current.environments; track row.environmentId) {
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
                      </td>
                    }
                    @if (current.enabled) {
                      <td class="cell-actions">
                        <button
                          type="button"
                          class="button"
                          [attr.aria-expanded]="selected()?.environmentId === row.environmentId"
                          [attr.aria-label]="
                            (selected()?.environmentId === row.environmentId ? 'Hide charts of ' : 'Show charts of ') +
                            row.applicationName +
                            ' in ' +
                            row.environmentName
                          "
                          (click)="toggle(row)"
                        >
                          {{ selected()?.environmentId === row.environmentId ? 'Hide charts' : 'Show charts' }}
                        </button>
                      </td>
                    }
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
          <section class="card" aria-labelledby="charts-heading">
            <div class="monitoring-charts-header">
              <h2 id="charts-heading">{{ chosen.applicationName }} in {{ chosen.environmentName }}</h2>
              <label class="field-inline">
                <span>Range</span>
                <select [value]="range()" (change)="chooseRange($event)">
                  @for (option of ranges; track option.key) {
                    <option [value]="option.key" [selected]="option.key === range()">{{ option.label }}</option>
                  }
                </select>
              </label>
            </div>
            @if (chartsError(); as message) {
              <p class="alert alert-error" role="alert">{{ message }}</p>
            } @else if (charts(); as metrics) {
              <div class="metric-grid">
                @for (series of metrics.series; track series.key) {
                  <app-metric-chart
                    [series]="series"
                    [start]="metrics.range.start"
                    [end]="metrics.range.end"
                    [stepSeconds]="metrics.range.stepSeconds"
                  />
                }
              </div>
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
  /** Counts chart requests, so an older answer never replaces a newer one. */
  #chartRequest = 0;

  protected readonly ranges = RANGES;
  protected readonly error = this.#activity.error;
  protected readonly loading = signal(true);
  protected readonly overview = signal<MonitoringOverview | null>(null);
  protected readonly selected = signal<MonitoredEnvironment | null>(null);
  protected readonly range = signal<TimeRangeKey>('1h');
  protected readonly charts = signal<EnvironmentMetrics | null>(null);
  protected readonly chartsError = signal<string | null>(null);

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

  protected sendsNothing(latest: MetricValues): boolean {
    return Object.values(latest).every((value) => value === null);
  }

  protected async toggle(environment: MonitoredEnvironment): Promise<void> {
    if (this.selected()?.environmentId === environment.environmentId) {
      this.selected.set(null);
      this.charts.set(null);
      this.chartsError.set(null);
      return;
    }
    this.selected.set(environment);
    this.charts.set(null);
    await this.#loadCharts();
  }

  protected async chooseRange(event: Event): Promise<void> {
    this.range.set((event.target as HTMLSelectElement).value as TimeRangeKey);
    this.charts.set(null);
    await this.#loadCharts();
  }

  async #loadOverview(): Promise<void> {
    this.overview.set(await this.#api.overview());
  }

  async #loadCharts(): Promise<void> {
    const environment = this.selected();
    if (environment === null) {
      return;
    }
    const request = ++this.#chartRequest;
    this.chartsError.set(null);
    try {
      const charts = await this.#api.environment(environment.environmentId, this.range());
      if (request === this.#chartRequest) {
        this.charts.set(charts);
      }
    } catch (error) {
      if (request === this.#chartRequest) {
        this.chartsError.set(errorMessage(error));
      }
    }
  }

  /** Reads everything on the page again every so often, while it's open. */
  #scheduleRefresh(): void {
    if (this.#destroyed) {
      return;
    }
    this.#refreshTimer = setTimeout(async () => {
      await this.#activity.run(() => this.#loadOverview());
      await this.#loadCharts();
      this.#scheduleRefresh();
    }, REFRESH_MS);
  }
}
