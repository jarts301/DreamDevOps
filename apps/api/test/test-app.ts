import type { INestApplication, Provider, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppConfig } from '../src/config/app-config.ts';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/configure-app.ts';
import { InMemorySessionStore } from '../src/session/in-memory-session-store.ts';
import { SESSION_STORE } from '../src/session/session-store.ts';
import { DATABASE_POOL } from '../src/tokens.ts';

export const PUBLIC_URL = 'http://api.test';
export const DASHBOARD_URL = 'http://dashboard.test/';

export const testConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  environment: 'test',
  port: 0,
  databaseUrl: 'postgres://unused',
  publicUrl: PUBLIC_URL,
  dashboardUrl: DASHBOARD_URL,
  identityProvider: 'fake',
  secureCookies: true,
  sessionIdleMs: 60_000,
  sessionAbsoluteMs: 600_000,
  rateLimitPerMinute: 10_000,
  authRateLimitPerMinute: 10_000,
  trustedProxies: 0,
  ...overrides,
});

export interface TestAppOptions {
  readonly config?: Partial<AppConfig>;
  readonly controllers?: readonly Type<unknown>[];
  readonly overrides?: readonly Provider[];
}

/** Builds the real application, replacing only the database with in-memory fakes. */
export async function createTestApp(options: TestAppOptions = {}): Promise<INestApplication> {
  const config = testConfig(options.config);
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({
      config,
      controllers: options.controllers ?? [],
      overrides: [
        { provide: SESSION_STORE, useValue: new InMemorySessionStore() },
        { provide: DATABASE_POOL, useValue: { query: async () => ({ rows: [] }), end: async () => {} } },
        ...(options.overrides ?? []),
      ],
    }),
    { bodyParser: false, logger: false },
  );
  configureApp(app, config);
  await app.init();
  // Each test client adds listeners to the same server, which is expected here.
  app.getHttpServer().setMaxListeners(0);
  return app;
}
