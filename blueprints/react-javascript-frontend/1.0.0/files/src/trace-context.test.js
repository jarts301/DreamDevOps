import { describe, expect, it, vi } from 'vitest';
import { isApiCall, newTraceparent, traceIdOf, tracedFetch } from './trace-context.js';

const TRACEPARENT = /^00-([0-9a-f]{32})-[0-9a-f]{16}-01$/;

/** A fetch that answers every call, and remembers them. */
const fakeFetch = () => vi.fn(/** @type {typeof fetch} */ (async () => new Response('{}')));

/**
 * The traceparent header a call was made with, or null.
 * @param {ReturnType<typeof fakeFetch>} fetcher
 * @param {number} call
 */
const traceparentOf = (fetcher, call) => new Headers(fetcher.mock.calls[call]?.[1]?.headers).get('traceparent');

describe('trace context', () => {
  it('makes W3C traceparent headers from random bytes', () => {
    /** @param {Uint8Array<ArrayBuffer>} bytes */
    const counting = (bytes) => bytes.map((_, index) => index + 1);

    expect(newTraceparent(counting)).toBe('00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01');
    expect(newTraceparent()).toMatch(TRACEPARENT);
    expect(traceIdOf('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('knows the app’s own API from everywhere else', () => {
    expect(isApiCall('/api/orders', '/api')).toBe(true);
    expect(isApiCall('/api', '/api/')).toBe(true);
    expect(isApiCall('/apiary', '/api')).toBe(false);
    expect(isApiCall('https://api.example.com/orders', 'https://api.example.com')).toBe(true);
    expect(isApiCall('https://fonts.example.com/font.woff2', 'https://api.example.com')).toBe(false);
  });

  it('starts a new trace for each call to the API, and for no other call', async () => {
    const fetcher = fakeFetch();
    const traced = tracedFetch('/api', fetcher);

    await traced('/api/orders');
    await traced(new URL('https://example.com/api/orders'));
    await traced('/api/orders', { headers: { accept: 'application/json' } });
    await traced('/config.json');

    expect(traceparentOf(fetcher, 0)).toMatch(TRACEPARENT);
    expect(traceparentOf(fetcher, 1)).toBeNull();
    expect(traceparentOf(fetcher, 2)).toMatch(TRACEPARENT);
    expect(traceIdOf(String(traceparentOf(fetcher, 0)))).not.toBe(traceIdOf(String(traceparentOf(fetcher, 2))));
    expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get('accept')).toBe('application/json');
    expect(traceparentOf(fetcher, 3)).toBeNull();
  });

  it('keeps a trace a call already has', async () => {
    const fetcher = fakeFetch();
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

    await tracedFetch('/api', fetcher)('/api/orders', { headers: { traceparent } });

    expect(traceparentOf(fetcher, 0)).toBe(traceparent);
  });
});
