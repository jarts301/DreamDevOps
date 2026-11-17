import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { LogLine } from './monitoring.api';

/**
 * What an application wrote, newest first, with each line's level, and a way to open the
 * trace a line was written in. A filter narrows the lines by text, level or trace ID.
 */
@Component({
  selector: 'app-log-view',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="log-toolbar">
      <label class="field-inline">
        <span>Filter</span>
        <input type="search" [value]="filter()" (input)="changeFilter($event)" placeholder="Text, level or trace ID" />
      </label>
      <span class="muted">{{ shown().length }} of {{ lines().length }} lines, newest first</span>
    </div>
    @if (lines().length === 0) {
      <p class="muted">{{ emptyMessage() }}</p>
    } @else if (shown().length === 0) {
      <p class="muted">No line matches the filter.</p>
    } @else {
      <ol class="log-lines">
        @for (line of shown(); track $index) {
          <li class="log-line" [attr.data-level]="line.level ?? line.stream">
            <time class="log-time" [attr.datetime]="line.at">{{ line.at | date: 'MMM d, HH:mm:ss.SSS' }}</time>
            <span class="log-level">{{ line.level ?? (line.stream === 'stderr' ? 'stderr' : '') }}</span>
            <span class="log-message">{{ line.message }}</span>
            @if (line.traceId; as traceId) {
              <button type="button" class="button log-trace" [attr.aria-label]="'Show trace ' + traceId" (click)="openTrace.emit(traceId)">
                Trace
              </button>
            }
          </li>
        }
      </ol>
    }
  `,
})
export class LogView {
  readonly lines = input.required<readonly LogLine[]>();
  /** What to say when there are no lines at all. */
  readonly emptyMessage = input('Nothing was written in this range.');
  readonly openTrace = output<string>();

  protected readonly filter = signal('');
  protected readonly shown = computed(() => {
    const text = this.filter().trim().toLowerCase();
    const matching =
      text === ''
        ? this.lines()
        : this.lines().filter((line) =>
            [line.message, line.level ?? '', line.traceId ?? ''].some((field) => field.toLowerCase().includes(text)),
          );
    return [...matching].reverse();
  });

  protected changeFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }
}
