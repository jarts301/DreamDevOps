import { describe, expect, it, vi } from 'vitest';
import { loadSettings } from './runtime-config.js';

describe('the runtime settings', () => {
  it('are read from /config.json, every time, so one image serves every environment', async () => {
    const fetcher = vi.fn(/** @type {typeof fetch} */ (async () => Response.json({ apiUrl: 'https://api.example.com' })));

    expect(await loadSettings(fetcher)).toEqual({ apiUrl: 'https://api.example.com' });
    expect(fetcher).toHaveBeenCalledWith('/config.json', { cache: 'no-store' });
  });

  it('call the API at /api unless they say otherwise', async () => {
    expect(await loadSettings(async () => Response.json({}))).toEqual({ apiUrl: '/api' });
  });

  it('say when they can’t be read', async () => {
    await expect(loadSettings(async () => new Response('', { status: 404 }))).rejects.toThrow('HTTP 404');
  });
});
