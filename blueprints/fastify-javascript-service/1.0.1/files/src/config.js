/**
 * The service's settings.
 * @typedef {object} Config
 * @property {string} host
 * @property {number} port
 * @property {readonly string[]} corsOrigins Web pages at these origins may call the service from browsers, such as https://shop.example.com.
 */

const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

/**
 * Reads settings from environment variables, so one image runs in every environment.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Config}
 */
export function loadConfig(env) {
  const port = Number(env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be a whole number between 1 and 65535.');
  }
  const corsOrigins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
  for (const origin of corsOrigins) {
    if (!ORIGIN.test(origin)) {
      throw new Error(`CORS_ORIGINS must list origins such as https://shop.example.com, and "${origin}" isn't one.`);
    }
  }
  return { host: env.HOST ?? '0.0.0.0', port, corsOrigins };
}
