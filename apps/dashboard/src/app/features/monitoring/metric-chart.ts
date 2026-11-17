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
 *
 * An orange line marks the daily high: the highest value in the day before the range.
 * It's what's been normal lately, so values above it stand out, and the chart says so.
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
          @if (dailyHighY() !== null) {
            <line class="metric-chart-daily-high" x1="0" [attr.x2]="width" [attr.y1]="dailyHighY()" [attr.y2]="dailyHighY()">
              <title>Daily high: {{ dailyHigh() }}</title>
            </line>
          }
          @for (line of lines(); track $index) {
            <polyline [attr.points]="line" />
          }
        </svg>
        <p class="metric-chart-daily-high-note" [attr.data-above]="above()">
          @if (series().dailyHigh === null) {
            No daily high yet: nothing was sent the day before.
          } @else {
            <span class="metric-chart-swatch" aria-hidden="true"></span>&ngsp;Daily high {{ dailyHigh() }}.
            @switch (above()) {
              @case ('now') {
                Now above it.
              }
              @case ('earlier') {
                Went above it in this range.
              }
            }
          }
        </p>
        <p class="cell-note">
          Highest {{ highest() }}{{ limit() ? ', of a limit of ' + limit() : '' }}. {{ series().description }}
        </p>
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
  /** What the container may use at most, in words, such as 512 MiB, for the metrics that have one. */
  readonly limit = input<string | null>(null);

  protected readonly width = WIDTH;
  protected readonly height = HEIGHT;

  protected readonly latest = computed(() => formatMetric(this.series().points.at(-1)?.value ?? null, this.series().unit));
  protected readonly highest = computed(() => formatMetric(this.#highestPoint(), this.series().unit));
  protected readonly dailyHigh = computed(() => formatMetric(this.series().dailyHigh, this.series().unit));

  /** Whether the values went above the daily high: now, earlier in the range, or not at all. */
  protected readonly above = computed((): 'now' | 'earlier' | null => {
    const high = this.series().dailyHigh;
    const points = this.series().points;
    if (high === null || !points.some((point) => point.value > high)) {
      return null;
    }
    return points.at(-1)!.value > high ? 'now' : 'earlier';
  });

  protected readonly summary = computed(() => {
    const daily = this.series().dailyHigh === null ? 'no daily high yet' : `daily high ${this.dailyHigh()}`;
    const above = this.above() === 'now' ? ', now above it' : this.above() === 'earlier' ? ', went above it' : '';
    return `${this.series().name}: latest ${this.latest()}, highest ${this.highest()}, ${daily}${above}, over ${this.series().points.length} points`;
  });

  /** Where the daily high's line sits, or null when there's none. */
  protected readonly dailyHighY = computed(() => {
    const high = this.series().dailyHigh;
    return high === null ? null : this.#y(high);
  });

  /** Each unbroken run of points, as SVG coordinates. */
  protected readonly lines = computed(() => {
    const start = Date.parse(this.start());
    const span = Math.max(Date.parse(this.end()) - start, 1);
    const gapMs = this.stepSeconds() * 1000 * 1.5;
    const runs: { x: number; y: number }[][] = [];
    let previous: number | null = null;
    for (const point of this.series().points) {
      const at = Date.parse(point.at);
      if (previous === null || at - previous > gapMs) {
        runs.push([]);
      }
      previous = at;
      runs.at(-1)!.push({ x: round(((at - start) / span) * WIDTH), y: this.#y(point.value) });
    }
    // A lone point gets a short stroke, so it shows.
    return runs.map((run) => (run.length === 1 ? [run[0]!, { x: run[0]!.x + 2, y: run[0]!.y }] : run).map(({ x, y }) => `${x},${y}`).join(' '));
  });

  #highestPoint(): number {
    return Math.max(0, ...this.series().points.map((point) => point.value));
  }

  /** The chart's top is its highest value, or the daily high if that's higher, so both fit. */
  #y(value: number): number {
    const top = Math.max(this.#highestPoint(), this.series().dailyHigh ?? 0);
    return round(HEIGHT - PADDING - (value / (top > 0 ? top : 1)) * (HEIGHT - 2 * PADDING));
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
