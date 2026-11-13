import { newTraceparent, traceIdOf } from './trace-context';

/** How a check of the API went. */
export interface Check {
  readonly answered: boolean;
  readonly message: string;
  /** The trace the check started, to look for in the API's logs and traces. */
  readonly traceId: string;
}

/** Calls the API's ping, with a trace of its own, so the API's logs and trace for it can be found. */
export async function checkApi(apiUrl: string, fetcher: typeof fetch = fetch): Promise<Check> {
  const traceparent = newTraceparent();
  const traceId = traceIdOf(traceparent);
  try {
    const response = await fetcher(`${apiUrl.replace(/\/$/, '')}/ping`, { headers: { traceparent } });
    return response.ok
      ? { answered: true, message: 'The API answered.', traceId }
      : { answered: false, message: `The API didn't answer (HTTP ${response.status}).`, traceId };
  } catch {
    return { answered: false, message: "The API didn't answer.", traceId };
  }
}
