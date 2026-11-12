import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, type OnDestroy, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { PageActivity } from '../../core/page-activity';
import { SessionService } from '../../core/session.service';
import { formatMetric } from '../monitoring/metric-format';
import type { MetricKey, MetricUnit } from '../monitoring/monitoring.api';
import { fromThreshold, inputUnit, parseAddresses, toThreshold, WAIT_CHOICES } from './alert-units';
import { type Alert, AlertsApi, type AlertsOverview, type Comparator, type Incident, type WatchableEnvironment } from './alerts.api';

/** How often the page reads alerts again while it's open, as they're checked every minute. */
export const REFRESH_MS = 30_000;

const MANAGE_ALERTS = 'alerts:manage';

const ENDINGS: Readonly<Record<NonNullable<Incident['endedBy']>, string>> = {
  recovered: 'Resolved',
  'turned-off': 'Turned off',
};

/**
 * The company's alerts: each watches one metric of one environment, and emails the
 * addresses it names when the metric crosses its threshold for long enough, and when it's
 * back. Every member who views dashboards sees them, and those who manage alerts change them.
 */
@Component({
  selector: 'app-alerts',
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Alerts</h1>
    <p class="lead">
      Get an email when what runs in an environment crosses a threshold for long enough, such as CPU above 80% for 5
      minutes, and again when it's back. Alerts are checked every minute, against the metrics on the
      <a routerLink="/monitoring">Monitoring</a> page.
    </p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }
    @if (notice(); as message) {
      <p class="alert alert-success" role="status">{{ message }}</p>
    }

    @if (loading()) {
      <p class="muted">Loading…</p>
    } @else if (overview(); as current) {
      @if (!current.metricsEnabled) {
        <p class="alert alert-info" role="status">
          This server doesn't keep applications' metrics yet, so alerts can't check anything. An administrator can set it up.
        </p>
      }

      @if (canManage()) {
        <section class="card" aria-labelledby="new-alert-heading">
          <h2 id="new-alert-heading">New alert</h2>
          @if (environments().length === 0) {
            <p class="muted">
              There's no environment to watch yet. Create one on the <a routerLink="/environments">Environments</a> page.
            </p>
          } @else {
            <form [formGroup]="form" (ngSubmit)="create()">
              <div class="form-row">
                <label class="field">
                  <span>Environment</span>
                  <select formControlName="environmentId">
                    @for (environment of environments(); track environment.environmentId) {
                      <option [value]="environment.environmentId">{{ placeName(environment) }}</option>
                    }
                  </select>
                </label>
                <label class="field">
                  <span>Name</span>
                  <input type="text" formControlName="name" maxlength="80" autocomplete="off" placeholder="High CPU" required />
                </label>
              </div>
              <div class="form-row">
                <label class="field">
                  <span>Metric</span>
                  <select formControlName="metric">
                    @for (metric of current.metrics; track metric.key) {
                      <option [value]="metric.key">{{ metric.name }}</option>
                    }
                  </select>
                </label>
                <label class="field">
                  <span>Fires when it goes</span>
                  <select formControlName="comparator">
                    <option value="above">Above</option>
                    <option value="below">Below</option>
                  </select>
                </label>
                <label class="field">
                  <span>Threshold ({{ unitLabel(form.controls.metric.value) }})</span>
                  <input type="number" formControlName="threshold" min="0" step="any" required />
                </label>
                <label class="field">
                  <span>How long</span>
                  <select formControlName="forMinutes">
                    @for (choice of waitChoices; track choice.minutes) {
                      <option [ngValue]="choice.minutes">{{ choice.label }}</option>
                    }
                  </select>
                </label>
              </div>
              <label class="field field-wide">
                <span>Email</span>
                <input type="text" formControlName="recipients" autocomplete="off" placeholder="you@example.com, on-call@example.com" required />
              </label>
              <p class="cell-note">Up to 10 addresses, separated by commas. Each gets an email when the alert fires and when it's resolved.</p>
              <div class="button-row">
                <button type="submit" class="button button-primary" [disabled]="form.invalid || working()">Create alert</button>
              </div>
            </form>
          }
        </section>
      }

      <section class="card" aria-labelledby="alerts-heading">
        <h2 id="alerts-heading">Alerts</h2>
        @if (current.alerts.length === 0) {
          <p class="muted">No alerts yet.</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Watches</th>
                  <th scope="col">Fires on</th>
                  <th scope="col">Status</th>
                  <th scope="col">Latest value</th>
                  <th scope="col">Emails</th>
                  @if (canManage()) {
                    <th scope="col"><span class="visually-hidden">Actions</span></th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (alert of current.alerts; track alert.id) {
                  <tr [attr.data-state]="alert.enabled ? alert.state : 'off'">
                    <td>{{ alert.name }}</td>
                    <td>
                      @if (alert.environmentName === null) {
                        <span class="muted">An environment that no longer exists</span>
                      } @else {
                        {{ alert.applicationName }} · {{ alert.environmentName }}
                        @if (alert.production) {
                          <span class="status" data-tone="production">Production</span>
                        }
                      }
                    </td>
                    <td>{{ alert.condition }}</td>
                    <td>
                      @if (!alert.enabled) {
                        <span class="status">Off</span>
                      } @else if (alert.state === 'firing') {
                        <span class="status" data-tone="danger">Firing</span>
                        @if (alert.firingSince) {
                          <p class="cell-note">Since {{ alert.firingSince | date: 'short' }}</p>
                        }
                      } @else if (alert.state === 'pending') {
                        <span class="status" data-tone="progress">Waiting</span>
                        @if (alert.pendingSince) {
                          <p class="cell-note">Past the threshold since {{ alert.pendingSince | date: 'shortTime' }}</p>
                        }
                      } @else {
                        <span class="status" data-tone="success">OK</span>
                      }
                    </td>
                    <td>
                      @if (alert.lastCheckedAt) {
                        {{ format(alert.lastValue, alert.metric) }}
                        <p class="cell-note">Checked {{ alert.lastCheckedAt | date: 'shortTime' }}</p>
                      } @else {
                        <span class="muted">Not checked yet</span>
                      }
                      @if (alert.enabled && alert.checkProblem) {
                        <p class="cell-note" data-tone="danger">Couldn't check: {{ alert.checkProblem }}</p>
                      }
                    </td>
                    <td>
                      @if (alert.recipients) {
                        {{ alert.recipients.join(', ') }}
                      } @else {
                        {{ alert.recipientCount }} {{ alert.recipientCount === 1 ? 'address' : 'addresses' }}
                      }
                      @if (alert.lastNotificationError) {
                        <p class="cell-note" data-tone="danger">Email failed: {{ alert.lastNotificationError }}</p>
                      }
                    </td>
                    @if (canManage()) {
                      <td class="cell-actions">
                        @if (deleting() === alert.id) {
                          <button type="button" class="button button-danger" [disabled]="working()" (click)="remove(alert)">
                            Confirm deletion
                          </button>
                          <button type="button" class="button" (click)="deleting.set(null)">Cancel</button>
                        } @else {
                          <button type="button" class="button" [attr.aria-label]="'Edit ' + alert.name" (click)="edit(alert)">Edit</button>
                          <button
                            type="button"
                            class="button"
                            [attr.aria-label]="'Send a test email for ' + alert.name"
                            [disabled]="working()"
                            (click)="test(alert)"
                          >
                            Test email
                          </button>
                          <button
                            type="button"
                            class="button"
                            [attr.aria-label]="(alert.enabled ? 'Turn off ' : 'Turn on ') + alert.name"
                            [disabled]="working()"
                            (click)="toggle(alert)"
                          >
                            {{ alert.enabled ? 'Turn off' : 'Turn on' }}
                          </button>
                          <button type="button" class="button" [attr.aria-label]="'Delete ' + alert.name" (click)="deleting.set(alert.id)">
                            Delete
                          </button>
                        }
                      </td>
                    }
                  </tr>
                  @if (editing() === alert.id) {
                    <tr>
                      <td colspan="7">
                        <form [formGroup]="editForm" (ngSubmit)="save(alert)" [attr.aria-label]="'Change ' + alert.name">
                          <div class="form-row">
                            <label class="field">
                              <span>Name</span>
                              <input type="text" formControlName="name" maxlength="80" autocomplete="off" required />
                            </label>
                            <label class="field">
                              <span>Threshold ({{ unitLabel(alert.metric) }})</span>
                              <input type="number" formControlName="threshold" min="0" step="any" required />
                            </label>
                            <label class="field">
                              <span>How long</span>
                              <select formControlName="forMinutes">
                                @for (choice of waitChoices; track choice.minutes) {
                                  <option [ngValue]="choice.minutes">{{ choice.label }}</option>
                                }
                              </select>
                            </label>
                          </div>
                          <label class="field field-wide">
                            <span>Email</span>
                            <input type="text" formControlName="recipients" autocomplete="off" required />
                          </label>
                          <p class="cell-note">
                            It keeps watching {{ metricName(alert.metric) }} {{ alert.comparator }} its threshold. To watch something
                            else, create another alert.
                          </p>
                          <div class="button-row">
                            <button type="submit" class="button button-primary" [disabled]="editForm.invalid || working()">Save</button>
                            <button type="button" class="button" (click)="editing.set(null)">Cancel</button>
                          </div>
                        </form>
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <section class="card" aria-labelledby="history-heading">
        <h2 id="history-heading">History</h2>
        @if (incidents().length === 0) {
          <p class="muted">No alert has fired yet.</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Alert</th>
                  <th scope="col">Where</th>
                  <th scope="col">Fired</th>
                  <th scope="col">Ended</th>
                </tr>
              </thead>
              <tbody>
                @for (incident of incidents(); track incident.id) {
                  <tr>
                    <td>
                      {{ incident.alertName }}
                      <p class="cell-note">{{ incident.condition }}</p>
                    </td>
                    <td>
                      {{ incident.applicationName ?? 'Unknown' }} · {{ incident.environmentName ?? 'Unknown' }}
                      @if (incident.production) {
                        <span class="status" data-tone="production">Production</span>
                      }
                    </td>
                    <td>
                      {{ incident.startedAt | date: 'short' }}
                      <p class="cell-note">At {{ incident.startValue }}</p>
                    </td>
                    <td>
                      @if (incident.resolvedAt) {
                        {{ ending(incident) }} {{ incident.resolvedAt | date: 'short' }}
                        @if (incident.endValue && incident.endedBy === 'recovered') {
                          <p class="cell-note">At {{ incident.endValue }}</p>
                        }
                      } @else {
                        <span class="status" data-tone="danger">Still firing</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    }
  `,
})
export class Alerts implements OnInit, OnDestroy {
  readonly #api = inject(AlertsApi);
  readonly #session = inject(SessionService);
  readonly #route = inject(ActivatedRoute);
  readonly #forms = inject(NonNullableFormBuilder);
  readonly #activity = new PageActivity('clear-when-starting');
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #destroyed = false;

  protected readonly waitChoices = WAIT_CHOICES;
  protected readonly working = this.#activity.working;
  protected readonly error = this.#activity.error;
  protected readonly notice = this.#activity.notice;
  protected readonly loading = signal(true);
  protected readonly overview = signal<AlertsOverview | null>(null);
  protected readonly incidents = signal<Incident[]>([]);
  protected readonly environments = signal<WatchableEnvironment[]>([]);
  protected readonly editing = signal<string | null>(null);
  protected readonly deleting = signal<string | null>(null);
  protected readonly canManage = computed(() => this.#session.can(MANAGE_ALERTS));

  protected readonly form = this.#forms.group({
    environmentId: ['', Validators.required],
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(80)]],
    metric: ['cpu' as MetricKey, Validators.required],
    comparator: ['above' as Comparator, Validators.required],
    threshold: [80, [Validators.required, Validators.min(0)]],
    forMinutes: [5, Validators.required],
    recipients: ['', Validators.required],
  });

  protected readonly editForm = this.#forms.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(80)]],
    threshold: [0, [Validators.required, Validators.min(0)]],
    forMinutes: [0, Validators.required],
    recipients: ['', Validators.required],
  });

  async ngOnInit(): Promise<void> {
    this.form.controls.recipients.setValue(this.#session.user()?.email ?? '');
    await this.#activity.run(async () => {
      const [, environments] = await Promise.all([
        this.#load(),
        this.canManage() ? this.#api.environments() : Promise.resolve([]),
      ]);
      this.environments.set(environments);
      // The Monitoring page links here with the environment to watch.
      const asked = this.#route.snapshot.queryParamMap.get('environment');
      const chosen = environments.find((environment) => environment.environmentId === asked) ?? environments[0];
      this.form.controls.environmentId.setValue(chosen?.environmentId ?? '');
    });
    this.loading.set(false);
    this.#scheduleRefresh();
  }

  ngOnDestroy(): void {
    this.#destroyed = true;
    clearTimeout(this.#refreshTimer);
  }

  protected placeName(environment: WatchableEnvironment): string {
    return `${environment.applicationName} · ${environment.environmentName}${environment.production ? ' (production)' : ''}`;
  }

  protected unitLabel(metric: MetricKey): string {
    return inputUnit(this.#unitOf(metric));
  }

  protected metricName(metric: MetricKey): string {
    return this.overview()?.metrics.find((definition) => definition.key === metric)?.name ?? metric;
  }

  protected format(value: number | null, metric: MetricKey): string {
    return formatMetric(value, this.#unitOf(metric));
  }

  protected ending(incident: Incident): string {
    return incident.endedBy === null ? 'Ended' : ENDINGS[incident.endedBy];
  }

  protected async create(): Promise<void> {
    const value = this.form.getRawValue();
    await this.#activity.change(async () => {
      const created = await this.#api.create({
        name: value.name,
        environmentId: value.environmentId,
        metric: value.metric,
        comparator: value.comparator,
        threshold: toThreshold(Number(value.threshold), this.#unitOf(value.metric)),
        forMinutes: Number(value.forMinutes),
        recipients: parseAddresses(value.recipients),
      });
      this.form.controls.name.reset();
      return `The alert "${created.name}" is created. It's checked every minute.`;
    }, () => this.#load());
  }

  protected edit(alert: Alert): void {
    this.deleting.set(null);
    this.editForm.setValue({
      name: alert.name,
      threshold: fromThreshold(alert.threshold, this.#unitOf(alert.metric)),
      forMinutes: alert.forMinutes,
      recipients: (alert.recipients ?? []).join(', '),
    });
    this.editing.set(alert.id);
  }

  protected async save(alert: Alert): Promise<void> {
    const value = this.editForm.getRawValue();
    await this.#activity.change(async () => {
      const saved = await this.#api.update(alert.id, {
        name: value.name,
        threshold: toThreshold(Number(value.threshold), this.#unitOf(alert.metric)),
        forMinutes: Number(value.forMinutes),
        recipients: parseAddresses(value.recipients),
      });
      this.editing.set(null);
      return `The alert "${saved.name}" is saved.`;
    }, () => this.#load());
  }

  protected async test(alert: Alert): Promise<void> {
    await this.#activity.run(async () => {
      const result = await this.#api.test(alert.id);
      if (result.delivered) {
        this.notice.set(`A test email was sent to ${result.sent} ${result.sent === 1 ? 'address' : 'addresses'}.`);
      } else {
        this.error.set(`The test email failed: ${result.error ?? 'unknown reason'}`);
      }
      await this.#load();
    });
  }

  protected async toggle(alert: Alert): Promise<void> {
    await this.#activity.change(async () => {
      await this.#api.update(alert.id, { enabled: !alert.enabled });
      return alert.enabled ? `The alert "${alert.name}" is off. It won't fire until it's turned on.` : `The alert "${alert.name}" is on.`;
    }, () => this.#load());
  }

  protected async remove(alert: Alert): Promise<void> {
    await this.#activity.change(async () => {
      await this.#api.remove(alert.id);
      this.deleting.set(null);
      return `The alert "${alert.name}" is deleted.`;
    }, () => this.#load());
  }

  #unitOf(metric: MetricKey): MetricUnit {
    return this.overview()?.metrics.find((definition) => definition.key === metric)?.unit ?? 'percent';
  }

  async #load(): Promise<void> {
    const [overview, incidents] = await Promise.all([this.#api.overview(), this.#api.incidents()]);
    this.overview.set(overview);
    this.incidents.set(incidents);
  }

  /** Reads the alerts again every so often while the page is open, as they're checked every minute. */
  #scheduleRefresh(): void {
    if (this.#destroyed) {
      return;
    }
    this.#refreshTimer = setTimeout(async () => {
      try {
        await this.#load();
      } catch {
        // The next refresh tries again. What's on screen stays meanwhile.
      }
      this.#scheduleRefresh();
    }, REFRESH_MS);
  }
}
