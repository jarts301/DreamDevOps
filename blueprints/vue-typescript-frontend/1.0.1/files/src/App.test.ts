import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.vue';
import { APP_NAME } from './app-info';
import { traceIdOf } from './trace-context';

const TRACEPARENT = /^00-([0-9a-f]{32})-[0-9a-f]{16}-01$/;
const SETTINGS = { apiUrl: 'https://api.example.com/' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('shows the application name and the API address from the runtime settings', () => {
    const app = mount(App, { props: { settings: SETTINGS } });

    expect(app.get('h1').text()).toBe(APP_NAME);
    expect(app.text()).toContain('https://api.example.com/');
  });

  it('pings the API with a new trace, and shows its ID so its logs and trace can be found', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ status: 'ok' }));
    vi.stubGlobal('fetch', fetcher);
    const app = mount(App, { props: { settings: SETTINGS } });

    await app.get('button').trigger('click');
    await flushPromises();

    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.example.com/ping');
    const traceparent = String(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('traceparent'));
    expect(traceparent).toMatch(TRACEPARENT);
    expect(app.get('[role="status"]').text()).toContain('The API answered.');
    expect(app.get('[role="status"] code').text()).toBe(traceIdOf(traceparent));
  });

  it('says when the API doesn’t answer', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })));
    const app = mount(App, { props: { settings: SETTINGS } });

    await app.get('button').trigger('click');
    await flushPromises();

    expect(app.get('[role="status"]').text()).toContain("The API didn't answer (HTTP 503).");
  });
});
