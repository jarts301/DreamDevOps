import { AggregationTemporality, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { afterEach, describe, expect, it } from 'vitest';
import { isHealthCheck, observeProcess, telemetrySettings } from '../src/metrics.js';

/** Collects metrics when the test asks, instead of on a timer. */
class TestReader extends MetricReader {
  async onForceFlush() {}
  async onShutdown() {}
}

describe('telemetry settings', () => {
  it('send nothing unless told where', () => {
    expect(telemetrySettings({})).toEqual({ metrics: false, traces: false, exportIntervalMs: 15_000 });
  });

  it('send only metrics when only their address is set, as the platform does', () => {
    const settings = telemetrySettings({
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://metrics.example.com/v1/metrics',
      OTEL_METRIC_EXPORT_INTERVAL: '60000',
    });

    expect(settings).toEqual({ metrics: true, traces: false, exportIntervalMs: 60_000 });
  });

  it('send metrics and traces to one address for both', () => {
    expect(telemetrySettings({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example.com:4318' })).toMatchObject({
      metrics: true,
      traces: true,
    });
  });

  it('keep the usual interval when the one given is not valid', () => {
    expect(telemetrySettings({ OTEL_METRIC_EXPORT_INTERVAL: 'often' }).exportIntervalMs).toBe(15_000);
  });

  it('leave health checks out of the measured traffic', () => {
    expect(isHealthCheck('/health/live')).toBe(true);
    expect(isHealthCheck('/health/ready')).toBe(true);
    expect(isHealthCheck('/api/hello')).toBe(false);
    expect(isHealthCheck(undefined)).toBe(false);
  });
});

describe('process metrics', () => {
  /** @type {MeterProvider | undefined} */
  let provider;

  afterEach(() => provider?.shutdown());

  it('report CPU time in seconds and memory in bytes, by their standard names', async () => {
    const reader = new TestReader({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
    provider = new MeterProvider({ readers: [reader] });
    observeProcess(provider.getMeter('test'), { cpu: () => ({ user: 1_500_000, system: 250_000 }), memory: () => 52_428_800 });

    const { resourceMetrics } = await reader.collect();
    const collected = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
    const byName = Object.fromEntries(collected.map((metric) => [metric.descriptor.name, metric]));

    expect(byName['process.cpu.time']?.descriptor.unit).toBe('s');
    expect(byName['process.cpu.time']?.dataPoints.map((point) => [point.attributes['cpu.mode'], point.value])).toEqual([
      ['user', 1.5],
      ['system', 0.25],
    ]);
    expect(byName['process.memory.usage']?.descriptor.unit).toBe('By');
    expect(byName['process.memory.usage']?.dataPoints.map((point) => point.value)).toEqual([52_428_800]);
  });
});
