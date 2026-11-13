/**
 * The app's settings, read when it starts.
 * @typedef {object} Settings
 * @property {string} apiUrl Where the app calls its API, such as /api or https://api.example.com.
 */

/** @type {Readonly<Settings>} */
export const DEFAULT_SETTINGS = { apiUrl: '/api' };

/**
 * Reads the settings from /config.json when the app starts. The container writes that file
 * from environment variables, so one image serves every environment. In development it's
 * public/config.json.
 * @param {typeof fetch} [fetcher]
 * @returns {Promise<Settings>}
 */
export async function loadSettings(fetcher = fetch) {
  const response = await fetcher('/config.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`The settings couldn't be read (HTTP ${response.status}).`);
  }
  /** @type {{ apiUrl?: unknown }} */
  const value = await response.json();
  return {
    apiUrl: typeof value.apiUrl === 'string' && value.apiUrl !== '' ? value.apiUrl : DEFAULT_SETTINGS.apiUrl,
  };
}
