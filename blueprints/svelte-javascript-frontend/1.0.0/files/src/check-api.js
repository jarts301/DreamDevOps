import { newTraceparent, traceIdOf } from './trace-context.js';

/**
 * How a check of the API went.
 * @typedef {object} Check
 * @property {boolean} answered
 * @property {string} message
 * @property {string} traceId The trace the check started, to look for in the API's logs and traces.
 */

/**
 * Calls the API's ping, with a trace of its own, so the API's logs and trace for it can be found.
 * @param {string} apiUrl
 * @param {typeof fetch} [fetcher]
 * @returns {Promise<Check>}
 */
export async function checkApi(apiUrl, fetcher = fetch) {
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
