export interface Config {
  readonly port: number;
  /** Without one, the API runs, and only what needs the database answers 503. */
  readonly databaseUrl: string | null;
}

export const CONFIG = Symbol('CONFIG');

const DEFAULT_PORT = 3000;

/** Reads the settings once at startup, and refuses any that aren't valid. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const port =
    env['PORT'] === undefined || env['PORT'] === ''
      ? DEFAULT_PORT
      : Number(env['PORT']);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be a whole number from 1 to 65535.');
  }
  const databaseUrl =
    env['DATABASE_URL'] === undefined || env['DATABASE_URL'] === ''
      ? null
      : env['DATABASE_URL'];
  if (databaseUrl !== null && !URL.canParse(databaseUrl)) {
    throw new Error(
      'DATABASE_URL must be a full URL, such as postgres://user:password@host:5432/database.',
    );
  }
  return { port, databaseUrl };
}
