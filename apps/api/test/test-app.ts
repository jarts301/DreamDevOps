import type { INestApplication, Provider, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { InMemoryJobQueue } from '@dreamdevops/shared-kernel/testing';
import { AppModule } from '../src/app.module.ts';
import { JOB_QUEUE, OUTBOX_RELAY, type Relay, RELAY_POOL } from '../src/background/background-work.ts';
import type { AppConfig } from '../src/config/app-config.ts';
import { configureApp } from '../src/configure-app.ts';
import { IDENTITY_PROVIDER, USER_DIRECTORY } from '../src/identity-access/application/ports.ts';
import { SESSION_STORE } from '../src/session/session-store.ts';
import { GIT_HOSTING } from '../src/tenancy/application/ports.ts';
import { DATABASE_POOL } from '../src/tokens.ts';
import { FakeIdentityProvider, InMemoryUserDirectory } from './fakes.ts';
import { InMemoryGitHosting } from './in-memory-git-hosting.ts';
import { InMemorySessionStore } from './in-memory-session-store.ts';

export const PUBLIC_URL = 'http://api.test';
export const DASHBOARD_URL = 'http://dashboard.test/';

export const testConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  environment: 'test',
  port: 0,
  databaseUrl: 'postgres://unused',
  relayDatabaseUrl: 'postgres://unused',
  jobsDatabaseUrl: 'postgres://unused',
  publicUrl: PUBLIC_URL,
  dashboardUrl: DASHBOARD_URL,
  keycloakIssuerUrl: 'http://unused',
  keycloakClientId: 'unused',
  keycloakClientSecret: 'unused',
  forgejoUrl: 'http://unused',
  forgejoUsername: 'unused',
  forgejoPassword: 'unused',
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

/** Records whether the application started and stopped the outbox relay. */
export class FakeRelay implements Relay {
  started = false;
  stopped = false;

  start(): void {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

/** The real application, with the database, login provider and other tools replaced by in-memory fakes. */
export function createTestApp(options: TestAppOptions = {}): Promise<INestApplication> {
  return buildApp({
    ...options,
    overrides: [
      { provide: SESSION_STORE, useValue: new InMemorySessionStore() },
      { provide: DATABASE_POOL, useValue: { query: async () => ({ rows: [] }), end: async () => {} } },
      { provide: RELAY_POOL, useValue: { end: async () => {} } },
      { provide: JOB_QUEUE, useValue: new InMemoryJobQueue() },
      { provide: OUTBOX_RELAY, useValue: new FakeRelay() },
      { provide: IDENTITY_PROVIDER, useValue: new FakeIdentityProvider() },
      { provide: USER_DIRECTORY, useValue: new InMemoryUserDirectory() },
      { provide: GIT_HOSTING, useValue: new InMemoryGitHosting() },
      ...(options.overrides ?? []),
    ],
  });
}
