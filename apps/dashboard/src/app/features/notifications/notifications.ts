import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../core/api-error';

export interface NotificationRule {
  readonly id: string;
  readonly name: string;
  readonly kind: 'slack' | 'generic';
  readonly destination: string;
  readonly eventTypes: readonly string[];
  readonly enabled: boolean;
  readonly lastDeliveryAt: string | null;
  readonly lastError: string | null;
}

interface EventType {
  readonly type: string;
  readonly description: string;
}

const BASE = '/api/v1/company/notification-rules';

@Component({
  selector: 'app-notifications',
  imports: [DatePipe, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Notifications</h1>
    <p class="lead">Post chosen events to a chat tool, such as a Slack channel.</p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }
    @if (notice(); as message) {
      <p class="alert alert-success" role="status">{{ message }}</p>
    }

    <section class="card" aria-labelledby="new-rule-heading">
      <h2 id="new-rule-heading">New rule</h2>
      <form [formGroup]="form" (ngSubmit)="create()">
        <div class="form-row">
          <label class="field">
            <span>Name</span>
            <input type="text" formControlName="name" maxlength="80" autocomplete="off" required />
          </label>
          <label class="field">
            <span>Format</span>
            <select formControlName="kind">
              <option value="slack">Slack incoming webhook</option>
              <option value="generic">Generic JSON</option>
            </select>
          </label>
        </div>
        <label class="field field-wide">
          <span>Webhook address</span>
          <input type="url" formControlName="url" autocomplete="off" placeholder="https://" required />
        </label>
        <fieldset class="checkbox-group">
          <legend>Events</legend>
          @for (eventType of eventTypes(); track eventType.type) {
            <label class="checkbox">
              <input
                type="checkbox"
                [checked]="chosen().has(eventType.type)"
                (change)="toggleEvent(eventType.type)"
              />
              {{ eventType.description }}
            </label>
          }
        </fieldset>
        <button
          type="submit"
          class="button button-primary"
          [disabled]="form.invalid || chosen().size === 0 || working()"
        >
          Create rule
        </button>
      </form>
      <p class="cell-note">The address is kept secret: after saving, only its site is shown.</p>
    </section>

    <section class="card" aria-labelledby="rules-heading">
      <h2 id="rules-heading">Rules</h2>
      @if (rules().length === 0) {
        <p class="muted">No rules yet.</p>
      } @else {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Sends to</th>
                <th scope="col">Events</th>
                <th scope="col">Last delivery</th>
                <th scope="col"><span class="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (rule of rules(); track rule.id) {
                <tr>
                  <td>
                    {{ rule.name }}
                    @if (!rule.enabled) {
                      <span class="muted">(off)</span>
                    }
                  </td>
                  <td>{{ rule.destination }}</td>
                  <td>{{ rule.eventTypes.length }}</td>
                  <td>
                    @if (rule.lastDeliveryAt) {
                      {{ rule.lastDeliveryAt | date: 'short' }}
                    } @else {
                      <span class="muted">Never</span>
                    }
                    @if (rule.lastError) {
                      <p class="cell-note">Failed: {{ rule.lastError }}</p>
                    }
                  </td>
                  <td class="cell-actions">
                    @if (deleting() === rule.id) {
                      <button type="button" class="button button-danger" [disabled]="working()" (click)="remove(rule)">
                        Confirm deletion
                      </button>
                      <button type="button" class="button" (click)="deleting.set(null)">Cancel</button>
                    } @else {
                      <button type="button" class="button" [attr.aria-label]="'Send a test from ' + rule.name" [disabled]="working()" (click)="test(rule)">
                        Test
                      </button>
                      <button type="button" class="button" [attr.aria-label]="(rule.enabled ? 'Turn off ' : 'Turn on ') + rule.name" [disabled]="working()" (click)="toggle(rule)">
                        {{ rule.enabled ? 'Turn off' : 'Turn on' }}
                      </button>
                      <button type="button" class="button" [attr.aria-label]="'Delete ' + rule.name" (click)="deleting.set(rule.id)">
                        Delete
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
})
export class Notifications implements OnInit {
  readonly #http = inject(HttpClient);
  readonly #forms = inject(NonNullableFormBuilder);

  protected readonly rules = signal<NotificationRule[]>([]);
  protected readonly eventTypes = signal<EventType[]>([]);
  protected readonly chosen = signal<ReadonlySet<string>>(new Set());
  protected readonly working = signal(false);
  protected readonly deleting = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);

  protected readonly form = this.#forms.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(80)]],
    kind: ['slack' as 'slack' | 'generic', Validators.required],
    url: ['', [Validators.required, Validators.pattern(/^https?:\/\/.+/)]],
  });

  async ngOnInit(): Promise<void> {
    await this.#attempt(async () => {
      this.eventTypes.set(await firstValueFrom(this.#http.get<EventType[]>(`${BASE}/event-types`)));
      await this.#refresh();
    });
  }

  protected toggleEvent(type: string): void {
    this.chosen.update((current) => {
      const next = new Set(current);
      if (!next.delete(type)) {
        next.add(type);
      }
      return next;
    });
  }

  protected async create(): Promise<void> {
    await this.#attempt(async () => {
      await firstValueFrom(this.#http.post(BASE, { ...this.form.getRawValue(), eventTypes: [...this.chosen()] }));
      this.form.reset();
      this.chosen.set(new Set());
      this.notice.set('Rule created.');
      await this.#refresh();
    });
  }

  protected async test(rule: NotificationRule): Promise<void> {
    await this.#attempt(async () => {
      const result = await firstValueFrom(
        this.#http.post<{ delivered: boolean; error: string | null }>(`${BASE}/${rule.id}/test`, {}),
      );
      if (result.delivered) {
        this.notice.set(`A test message was sent to ${rule.destination}.`);
      } else {
        this.error.set(`The test message failed: ${result.error}`);
      }
      await this.#refresh();
    });
  }

  protected async toggle(rule: NotificationRule): Promise<void> {
    await this.#attempt(async () => {
      await firstValueFrom(this.#http.patch(`${BASE}/${rule.id}`, { enabled: !rule.enabled }));
      await this.#refresh();
    });
  }

  protected async remove(rule: NotificationRule): Promise<void> {
    await this.#attempt(async () => {
      await firstValueFrom(this.#http.delete(`${BASE}/${rule.id}`));
      this.deleting.set(null);
      await this.#refresh();
    });
  }

  async #refresh(): Promise<void> {
    this.rules.set(await firstValueFrom(this.#http.get<NotificationRule[]>(BASE)));
  }

  async #attempt(work: () => Promise<void>): Promise<void> {
    this.error.set(null);
    this.notice.set(null);
    this.working.set(true);
    try {
      await work();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.working.set(false);
    }
  }
}
