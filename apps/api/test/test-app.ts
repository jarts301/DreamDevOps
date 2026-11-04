import type { INestApplication, Provider, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module.ts';
import type { AppConfig } from '../src/config/app-config.ts';
import { configureApp } from '../src/configure-app.ts';
import { IDENTITY_PROVIDER, USER_DIRECTORY } from '../src/identity-access/application/ports.ts';
import { InMemorySessionStore } from '../src/session/in-memory-session-store.ts';
import { SESSION_STORE } from '../src/session/session-store.ts';
import { DATABASE_POOL } from '../src/tokens.ts';
import { FakeIdentityProvider, InMemoryUserDirectory } from './fakes.ts';

export const PUBLIC_URL = 'http://api.test';
export const DASHBOARD_URL = 'http://dashboard.test/';

export const testConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  environment: 'test',
  port: 0,
  databaseUrl: 'postgres://unused',
  publicUrl: PUBLIC_URL,
  dashboardUrl: DASHBOARD_URL,
  keycloakIssuerUrl: 'http://unused',
  keycloakClientId: 'unused',
  keycloakClientSecret: 'unused',
  requireVerifiedEmail: true,
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

/** Builds the real application from explicit providers. */
export async function buildApp(options: TestAppOptions): Promise<INestApplication> {
  const config = testConfig(options.config);
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({
      config,
      controllers: options.controllers ?? [],
      overrides: options.overrides ?? [],
    }),
    { bodyParser: false, logger: false },
  );
  configureApp(app, config);
  await app.init();
  // Each test client adds listeners to the same server, which is expected here.
  app.getHttpServer().setMaxListeners(0);
  return app;
}

/** The real application, with the database and login provider replaced by in-memory fakes. */
export function createTestApp(options: TestAppOptions = {}): Promise<INestApplication> {
  return buildApp({
    ...options,
    overrides: [
      { provide: SESSION_STORE, useValue: new InMemorySessionStore() },
      { provide: DATABASE_POOL, useValue: { query: async () => ({ rows: [] }), end: async () => {} } },
      { provide: IDENTITY_PROVIDER, useValue: new FakeIdentityProvider() },
      { provide: USER_DIRECTORY, useValue: new InMemoryUserDirectory() },
      ...(options.overrides ?? []),
    ],
  });
}
