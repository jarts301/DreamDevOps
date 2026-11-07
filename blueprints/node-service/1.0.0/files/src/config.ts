export interface Config {
  readonly host: string;
  readonly port: number;
}

/** Reads settings from environment variables, so one image runs in every environment. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const port = Number(env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be a whole number between 1 and 65535.');
  }
  return { host: env.HOST ?? '0.0.0.0', port };
}
