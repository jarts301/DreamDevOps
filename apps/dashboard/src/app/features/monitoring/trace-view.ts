import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { formatDuration } from './metric-format';
import type { Span, Trace } from './monitoring.api';

interface Row {
  readonly span: Span;
  /** How deep it sits under the spans it happened within. */
  readonly depth: number;
  /** Where its bar starts and how long it is, in percent of the trace. */
  readonly left: number;
  readonly width: number;
  /** What it did, such as GET /api/ping 200. */
  readonly detail: string;
}

/**
 * One trace as a timeline: each span under the one it happened within, with a bar for
 * when it ran, so a slow or failing step across applications stands out.
 */
@Component({
  selector: 'app-trace-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p>
      Took {{ duration(trace().durationMs) }}, in {{ trace().spans.length === 1 ? '1 span' : trace().spans.length + ' spans' }}.
      @if (trace().hiddenSpans > 0) {
        {{ trace().hiddenSpans === 1 ? '1 span' : trace().hiddenSpans + ' spans' }} from outside your company's applications
        aren't shown.
      }
    </p>
    <ol class="trace-spans">
      @for (row of rows(); track row.span.spanId) {
        <li class="trace-span" [attr.data-error]="row.span.error">
          <div class="trace-span-label" [style.padding-left.rem]="row.depth">
            <strong>{{ row.span.name }}</strong>&ngsp;
            <span class="muted">{{ row.span.applicationName }} in {{ row.span.environmentName }}</span>&ngsp;
            @if (row.span.error) {
              <span class="status" data-tone="danger">Error</span>&ngsp;
            }
            @if (row.detail) {
              <p class="cell-note">{{ row.detail }}</p>
            }
          </div>
          <div class="trace-span-track" aria-hidden="true">
            <span class="trace-span-bar" [style.left.%]="row.left" [style.width.%]="row.width"></span>
          </div>
          <span class="trace-span-duration">{{ duration(row.span.durationMs) }}</span>
        </li>
      }
    </ol>
  `,
})
export class TraceView {
  readonly trace = input.required<Trace>();

  protected readonly duration = formatDuration;

  /** The spans in the order they happened within each other: each one right under the span it's part of. */
  protected readonly rows = computed((): Row[] => {
    const { spans, durationMs } = this.trace();
    const ids = new Set(spans.map((span) => span.spanId));
    const children = new Map<string | null, Span[]>();
    for (const span of spans) {
      // A span whose parent isn't shown, such as a browser's, starts a branch of its own.
      const parent = span.parentSpanId !== null && ids.has(span.parentSpanId) ? span.parentSpanId : null;
      children.set(parent, [...(children.get(parent) ?? []), span]);
    }
    const total = Math.max(durationMs, 0.001);
    const rows: Row[] = [];
    const visit = (parent: string | null, depth: number) => {
      for (const span of [...(children.get(parent) ?? [])].sort((left, right) => left.offsetMs - right.offsetMs)) {
        rows.push({
          span,
          depth,
          left: (span.offsetMs / total) * 100,
          width: Math.max((span.durationMs / total) * 100, 0.5),
          detail: detailOf(span),
        });
        visit(span.spanId, depth + 1);
      }
    };
    visit(null, 0);
    return rows;
  });
}

/** What a span did, from OpenTelemetry's standard HTTP attributes, such as GET /api/ping 200. */
function detailOf(span: Span): string {
  const attribute = (key: string) => {
    const value = span.attributes[key];
    return value === undefined ? null : String(value);
  };
  return [
    span.kind,
    attribute('http.request.method'),
    attribute('http.route') ?? attribute('url.path') ?? attribute('url.full'),
    attribute('http.response.status_code'),
  ]
    .filter((part) => part !== null)
    .join(' ');
}
