import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, type OnInit, signal } from '@angular/core';
import { errorMessage } from '../../core/api-error';
import { describeEvent } from '../../core/events';
import { type ActivityEntry, AuditApi } from './audit.api';

/** A platform admin's own actions, across every company they acted on. */
@Component({
  selector: 'app-my-activity',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>My activity</h1>
    <p class="lead">What you've changed, in every company, newest first.</p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }

    <section class="card">
      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else if (entries().length === 0) {
        <p class="muted">You haven't changed anything yet.</p>
      } @else {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Company</th>
                <th scope="col">What</th>
              </tr>
            </thead>
            <tbody>
              @for (entry of entries(); track $index) {
                <tr>
                  <td>{{ entry.occurredAt | date: 'medium' }}</td>
                  <td>{{ entry.companyName }}</td>
                  <td>{{ describe(entry) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (nextBefore() !== null) {
          <button type="button" class="button" (click)="load()">Show older activity</button>
        }
      }
    </section>
  `,
})
export class MyActivity implements OnInit {
  readonly #api = inject(AuditApi);

  protected readonly entries = signal<ActivityEntry[]>([]);
  protected readonly nextBefore = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    await this.load();
    this.loading.set(false);
  }

  protected describe(entry: ActivityEntry): string {
    return describeEvent(entry.eventType, entry.payload);
  }

  protected async load(): Promise<void> {
    this.error.set(null);
    try {
      const page = await this.#api.myActivity(this.nextBefore());
      this.entries.update((entries) => [...entries, ...page.entries]);
      this.nextBefore.set(page.nextBefore);
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }
}
