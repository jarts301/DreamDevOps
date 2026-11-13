/** The app's settings, read when it starts. */
export interface Settings {
  /** Where the app calls its API, such as /api or https://api.example.com. */
  readonly apiUrl: string;
}

export const DEFAULT_SETTINGS: Settings = { apiUrl: '/api' };

/**
 * Reads the settings from /config.json when the app starts. The container writes that file
 * from environment variables, so one image serves every environment. In development it's
 * public/config.json.
 */
export async function loadSettings(fetcher: typeof fetch = fetch): Promise<Settings> {
  const response = await fetcher('/config.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`The settings couldn't be read (HTTP ${response.status}).`);
  }
  const value = (await response.json()) as Partial<Record<keyof Settings, unknown>>;
  return {
    apiUrl: typeof value.apiUrl === 'string' && value.apiUrl !== '' ? value.apiUrl : DEFAULT_SETTINGS.apiUrl,
  };
}
