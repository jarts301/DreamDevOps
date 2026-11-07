import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, type OnInit, signal } from '@angular/core';
import { errorMessage } from '../../core/api-error';
import { describeEvent } from '../../core/events';
import { type AuditEntry, AuditApi, type IntegrityCheck } from './audit.api';

@Component({
  selector: 'app-audit-log',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Audit log</h1>
    <p class="lead">
      Every change in this company, newest first. Entries can't be changed or deleted. Their numbers show the
      order they were recorded in, which can differ slightly from the order the changes happened.
    </p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }

    <section class="card" aria-labelledby="integrity-heading">
      <h2 id="integrity-heading">Integrity</h2>
      <p>Checks that no entry was changed, removed or reordered since it was recorded.</p>
      <button type="button" class="button" [disabled]="checking()" (click)="verify()">Check integrity</button>
      @if (check(); as result) {
        @if (result.valid) {
          <p class="alert alert-success" role="status">The log is intact. {{ result.checked }} entries checked.</p>
        } @else {
          <p class="alert alert-error" role="alert">
            The log was tampered with at entry {{ result.brokenAtSequence }}: {{ result.reason }}
          </p>
        }
      }
    </section>

    <section class="card" aria-labelledby="entries-heading">
      <h2 id="entries-heading">Entries</h2>
      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else if (entries().length === 0) {
        <p class="muted">Nothing has been recorded yet.</p>
      } @else {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
              </tr>
            </thead>
            <tbody>
              @for (entry of entries(); track entry.sequence) {
                <tr>
                  <td>{{ entry.sequence }}</td>
                  <td>{{ entry.occurredAt | date: 'medium' }}</td>
                  <td>{{ actorName(entry) }}</td>
                  <td>{{ describe(entry) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (nextBefore() !== null) {
          <button type="button" class="button" [disabled]="loadingMore()" (click)="loadMore()">Show older entries</button>
        }
      }
    </section>
  `,
})
export class AuditLog implements OnInit {
  readonly #api = inject(AuditApi);

  protected readonly entries = signal<AuditEntry[]>([]);
  protected readonly nextBefore = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadingMore = signal(false);
  protected readonly checking = signal(false);
  protected readonly check = signal<IntegrityCheck | null>(null);
  protected readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    await this.#load(null);
    this.loading.set(false);
  }

  protected actorName(entry: AuditEntry): string {
    return entry.actor === null ? 'DreamDevOps' : (entry.actor.displayName ?? 'A former user');
  }

  protected describe(entry: AuditEntry): string {
    return describeEvent(entry.eventType, entry.payload);
  }

  protected async loadMore(): Promise<void> {
    this.loadingMore.set(true);
    await this.#load(this.nextBefore());
    this.loadingMore.set(false);
  }

  protected async verify(): Promise<void> {
    this.error.set(null);
    this.checking.set(true);
    try {
      this.check.set(await this.#api.verify());
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.checking.set(false);
    }
  }

  async #load(before: string | null): Promise<void> {
    this.error.set(null);
    try {
      const page = await this.#api.companyLog(before);
      this.entries.update((entries) => [...entries, ...page.entries]);
      this.nextBefore.set(page.nextBefore);
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }
}
