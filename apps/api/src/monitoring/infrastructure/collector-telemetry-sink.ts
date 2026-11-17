import { LogsUnavailableError, type TelemetryKind, type TelemetrySink } from '../application/ports.ts';

/**
 * Sends checked telemetry to the platform's OpenTelemetry collector over OTLP/HTTP, as
 * JSON. The collector passes metrics to Prometheus, traces to Jaeger and logs to Loki.
 */
export class CollectorTelemetrySink implements TelemetrySink {
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(options: { readonly url: string; readonly fetch?: typeof fetch }) {
    this.#url = options.url.replace(/\/$/, '');
    this.#fetch = options.fetch ?? fetch;
  }

  async send(kind: TelemetryKind, body: object): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}/v1/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new LogsUnavailableError('The platform’s collector can’t be reached right now.');
    }
    await response.body?.cancel();
    if (!response.ok) {
      throw new LogsUnavailableError(`The platform’s collector refused the ${kind} (HTTP ${response.status}).`);
    }
  }
}
