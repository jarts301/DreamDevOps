import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { vi } from 'vitest';

/**
 * Runs queries as the application does for one context: logged in as the application's role,
 * switched to the context's own role, in a company's context or in none. Nothing is kept: the
 * transaction is rolled back.
 */
export async function asContextRole<T>(
  connectionString: string,
  role: string,
  companyId: string | null,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    if (companyId !== null) {
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
    }
    return await work(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

/** Signs in the way a browser does, through the fake login provider, and keeps the cookies. */
export async function signIn(app: INestApplication, user: string) {
  const agent = request.agent(app.getHttpServer());
  const login = await agent.get(`/api/v1/auth/login?login_hint=${user}`).expect(302);
  const callback = new URL(login.headers.location as string);
  await agent.get(callback.pathname + callback.search).expect(302);
  return agent;
}

export type Agent = Awaited<ReturnType<typeof signIn>>;

let counter = 0;

/**
 * A name no earlier call in this test file returned, such as "company-ab". The fake login
 * turns names into users, so they hold only lowercase letters and hyphens.
 */
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${'abcdefghijklmnopqrstuvwxyz'[Math.floor(counter / 26) % 26]}${'abcdefghijklmnopqrstuvwxyz'[counter % 26]}`;
}

/** Waits until an assertion passes, for work done in the background. */
export function eventually(
  assertion: () => Promise<void> | void,
  options: { readonly timeout?: number; readonly interval?: number } = {},
) {
  return vi.waitFor(assertion, { timeout: options.timeout ?? 20_000, interval: options.interval ?? 150 });
}
