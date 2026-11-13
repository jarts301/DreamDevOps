/**
 * Fills bytes with random values. Tests pass their own.
 * @typedef {(bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>} RandomBytes
 */

/** @type {RandomBytes} */
const secureRandom = (bytes) => crypto.getRandomValues(bytes);

/**
 * A W3C traceparent header that starts a new trace, such as
 * 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01. The API continues it, and so
 * do the services it calls, so one click is one trace across all of them.
 * @param {RandomBytes} [random]
 * @returns {string}
 */
export function newTraceparent(random = secureRandom) {
  /** @param {number} length */
  const hex = (length) => [...random(new Uint8Array(length))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `00-${hex(16)}-${hex(8)}-01`;
}

/**
 * The trace ID in a traceparent header, which is how the trace is found.
 * @param {string} traceparent
 * @returns {string}
 */
export function traceIdOf(traceparent) {
  return traceparent.split('-')[1] ?? '';
}

/**
 * Whether a URL is one of the app's own API, such as /api/orders when the API is at /api.
 * @param {string} url
 * @param {string} apiUrl
 * @returns {boolean}
 */
export function isApiCall(url, apiUrl) {
  const api = apiUrl.replace(/\/$/, '');
  return url === api || url.startsWith(`${api}/`);
}

/**
 * fetch, starting a trace for each call to the app's own API, unless the call has one
 * already. Calls anywhere else, such as for /config.json, don't get one, so no trace leaks
 * to other sites.
 * @param {string} apiUrl
 * @param {typeof fetch} [fetcher]
 * @returns {typeof fetch}
 */
export function tracedFetch(apiUrl, fetcher = fetch) {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    if (isApiCall(url, apiUrl) && !headers.has('traceparent')) {
      headers.set('traceparent', newTraceparent());
    }
    return fetcher(input, { ...init, headers });
  };
}
