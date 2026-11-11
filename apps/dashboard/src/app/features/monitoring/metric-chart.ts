import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { formatMetric } from './metric-format';
import type { MetricSeries } from './monitoring.api';

const WIDTH = 300;
const HEIGHT = 80;
/** Space kept above and below the line, so its highest and lowest points stay visible. */
const PADDING = 4;

/**
 * One metric over a time range, as a line. Where the application sent nothing for more
 * than a step, such as while it was stopped, the line breaks, so a gap never reads as a
 * steady value.
 */
@Component({
  selector: 'app-metric-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure class="metric-chart">
      <figcaption>
        <span class="metric-chart-name">{{ series().name }}</span>&ngsp;
        <strong class="metric-chart-latest">{{ latest() }}</strong>
      </figcaption>
      @if (series().points.length === 0) {
        <p class="metric-chart-empty muted">No data in this range.</p>
      } @else {
        <svg
          class="metric-chart-plot"
          [attr.viewBox]="'0 0 ' + width + ' ' + height"
          preserveAspectRatio="none"
          role="img"
          [attr.aria-label]="summary()"
        >
          @for (line of lines(); track $index) {
            <polyline [attr.points]="line" />
          }
        </svg>
        <p class="cell-note">Highest {{ highest() }}. {{ series().description }}</p>
      }
    </figure>
  `,
})
export class MetricChart {
  readonly series = input.required<MetricSeries>();
  /** The range the chart covers, so points sit where they happened. */
  readonly start = input.required<string>();
  readonly end = input.required<string>();
  readonly stepSeconds = input.required<number>();

  protected readonly width = WIDTH;
  protected readonly height = HEIGHT;

  protected readonly latest = computed(() => formatMetric(this.series().points.at(-1)?.value ?? null, this.series().unit));
  protected readonly highest = computed(() => formatMetric(this.#top(), this.series().unit));
  protected readonly summary = computed(
    () => `${this.series().name}: latest ${this.latest()}, highest ${this.highest()}, over ${this.series().points.length} points`,
  );

  /** Each unbroken run of points, as SVG coordinates. */
  protected readonly lines = computed(() => {
    const start = Date.parse(this.start());
    const span = Math.max(Date.parse(this.end()) - start, 1);
    const top = this.#top() > 0 ? this.#top() : 1;
    const gapMs = this.stepSeconds() * 1000 * 1.5;
    const runs: { x: number; y: number }[][] = [];
    let previous: number | null = null;
    for (const point of this.series().points) {
      const at = Date.parse(point.at);
      if (previous === null || at - previous > gapMs) {
        runs.push([]);
      }
      previous = at;
      runs.at(-1)!.push({
        x: round(((at - start) / span) * WIDTH),
        y: round(HEIGHT - PADDING - (point.value / top) * (HEIGHT - 2 * PADDING)),
      });
    }
    // A lone point gets a short stroke, so it shows.
    return runs.map((run) => (run.length === 1 ? [run[0]!, { x: run[0]!.x + 2, y: run[0]!.y }] : run).map(({ x, y }) => `${x},${y}`).join(' '));
  });

  #top(): number {
    return Math.max(0, ...this.series().points.map((point) => point.value));
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
