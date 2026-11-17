import type { TelemetryKind, TelemetrySink } from '../../src/monitoring/application/ports.ts';

/** Keeps what the telemetry gateway forwards, instead of sending it to a collector. */
export class FakeTelemetrySink implements TelemetrySink {
  readonly sent: { kind: TelemetryKind; body: Record<string, unknown> }[] = [];

  async send(kind: TelemetryKind, body: object): Promise<void> {
    this.sent.push({ kind, body: body as Record<string, unknown> });
  }
}
