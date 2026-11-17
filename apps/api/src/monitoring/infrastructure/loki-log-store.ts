import { isUuid } from '@dreamdevops/shared-kernel';
import { PLACE_ATTRIBUTE } from '../../environments/domain/telemetry.ts';
import { type LogEntry, type LogStore, LogsUnavailableError } from '../application/ports.ts';

export interface LokiOptions {
  /** Such as http://localhost:3100. */
  readonly url: string;
  readonly timeoutMs?: number;
  /** Makes HTTP requests. Tests pass their own. */
  readonly fetch?: typeof fetch;
}

/** Loki names the place's resource attribute this way, as an index label, as infra/local/loki asks. */
export const PLACE_LOG_LABEL = PLACE_ATTRIBUTE.replace(/[^A-Za-z0-9_]/g, '_');

interface LokiAnswer {
  status?: string;
  data?: { result?: { stream?: Record<string, string>; values?: [string, string][] }[] };
}

/**
 * Reads applications' logs from Loki, which receives them over OTLP from the platform's
 * collector. Every query names the one place it's about, by its ID, so it can't return another's.
 */
export class LokiLogStore implements LogStore {
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: LokiOptions) {
    this.#url = options.url.replace(/\/$/, '');
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#fetch = options.fetch ?? fetch;
  }

  async recent(placeId: string, options: { readonly since: Date; readonly limit: number }): Promise<LogEntry[]> {
    if (!isUuid(placeId)) {
      throw new Error(`"${placeId}" isn't a place ID.`);
    }
    const parameters = new URLSearchParams({
      query: `{${PLACE_LOG_LABEL}="${placeId}"}`,
      start: `${options.since.getTime()}000000`,
      end: `${Date.now()}000000`,
      limit: String(options.limit),
      // The newest lines, which are then put oldest first.
      direction: 'backward',
    });
    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}/loki/api/v1/query_range?${parameters.toString()}`, {
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new LogsUnavailableError('The log store can’t be reached right now. Try again shortly.');
    }
    const answer = (await response.json().catch(() => ({}))) as LokiAnswer;
    if (!response.ok || answer.status !== 'success') {
      throw new LogsUnavailableError(`The log store couldn’t answer (HTTP ${response.status}). Try again shortly.`);
    }
    return (answer.data?.result ?? [])
      .flatMap((result) =>
        (result.values ?? []).map(([nanoseconds, text]) => ({
          at: new Date(Number(BigInt(nanoseconds) / 1_000_000n)),
          // The cluster's collector records which output a line came from.
          stream: result.stream?.['log_iostream'] === 'stderr' ? ('stderr' as const) : ('stdout' as const),
          text,
        })),
      )
      .sort((left, right) => left.at.getTime() - right.at.getTime())
      .slice(-options.limit);
  }
}
