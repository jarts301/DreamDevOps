import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { formatDuration } from './metric-format';
import type { TraceSummary } from './monitoring.api';

/** An environment's latest traces, newest first, each opened on request. */
@Component({
  selector: 'app-trace-list',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (traces().length === 0) {
      <p class="muted">No traces in this range.</p>
    } @else {
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Operation</th>
              <th scope="col" class="metric-value">Took</th>
              <th scope="col" class="metric-value">Spans</th>
              <th scope="col"><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            @for (trace of traces(); track trace.traceId) {
              <tr>
                <td>{{ trace.start | date: 'MMM d, HH:mm:ss' }}</td>
                <td>
                  {{ trace.name }}
                  @if (trace.errors > 0) {
                    <span class="status" data-tone="danger">{{ trace.errors === 1 ? '1 error' : trace.errors + ' errors' }}</span>&ngsp;
                  }
                  <p class="cell-note"><code>{{ trace.traceId }}</code></p>
                </td>
                <td class="metric-value">{{ duration(trace.durationMs) }}</td>
                <td class="metric-value">{{ trace.spans }}</td>
                <td class="cell-actions">
                  <button type="button" class="button" [attr.aria-label]="'Show trace ' + trace.traceId" (click)="open.emit(trace.traceId)">
                    Show trace
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class TraceList {
  readonly traces = input.required<readonly TraceSummary[]>();
  readonly open = output<string>();

  protected readonly duration = formatDuration;
}
