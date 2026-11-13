import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';
import { APP_NAME } from './app-info.js';
import { traceIdOf } from './trace-context.js';

const TRACEPARENT = /^00-([0-9a-f]{32})-[0-9a-f]{16}-01$/;
const SETTINGS = { apiUrl: 'https://api.example.com/' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('shows the application name and the API address from the runtime settings', () => {
    render(App, { props: { settings: SETTINGS } });

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(APP_NAME);
    expect(document.body.textContent).toContain('https://api.example.com/');
  });

  it('pings the API with a new trace, and shows its ID so its logs and trace can be found', async () => {
    const fetcher = vi.fn(/** @type {typeof fetch} */ (async () => Response.json({ status: 'ok' })));
    vi.stubGlobal('fetch', fetcher);
    render(App, { props: { settings: SETTINGS } });

    await fireEvent.click(screen.getByRole('button', { name: 'Check the API' }));

    const status = await screen.findByRole('status');
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.example.com/ping');
    const traceparent = String(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('traceparent'));
    expect(traceparent).toMatch(TRACEPARENT);
    expect(status.textContent).toContain('The API answered.');
    expect(status.querySelector('code')?.textContent).toBe(traceIdOf(traceparent));
  });

  it('says when the API doesn’t answer', async () => {
    vi.stubGlobal('fetch', vi.fn(/** @type {typeof fetch} */ (async () => new Response(null, { status: 503 }))));
    render(App, { props: { settings: SETTINGS } });

    await fireEvent.click(screen.getByRole('button', { name: 'Check the API' }));

    expect((await screen.findByRole('status')).textContent).toContain("The API didn't answer (HTTP 503).");
  });
});
