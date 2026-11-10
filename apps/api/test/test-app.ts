import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INestApplication, Provider, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module.ts';
import { BACKGROUND_PROCESSING, NoBackgroundProcessing } from '../src/background/background-processing.ts';
import type { AppConfig } from '../src/config/app-config.ts';
import { configureApp } from '../src/configure-app.ts';
import { IDENTITY_PROVIDER, USER_DIRECTORY } from '../src/identity-access/application/ports.ts';
import { SESSION_STORE } from '../src/session/session-store.ts';
import { DATABASE_POOL } from '../src/tokens.ts';
import { MAILER } from '../src/notifications/application/ports.ts';
import { SOURCE_HOST } from '../src/source-governance/application/ports.ts';
import { IMAGE_REGISTRY, PIPELINE_HOST } from '../src/builds/application/ports.ts';
import {
  FakeIdentityProvider,
  FakeImageRegistry,
  FakeMailer,
  FakePipelineHost,
  FakeSourceHost,
  InMemoryUserDirectory,
} from './fakes.ts';
import { InMemorySessionStore } from './in-memory-session-store.ts';

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
  relayDatabaseUrl: 'postgres://unused',
  jobsDatabaseUrl: 'postgres://unused',
  relayPollMs: 50,
  jobPollingSeconds: 1,
  forgejoUrl: 'http://unused',
  forgejoUsername: 'unused',
  forgejoPassword: 'unused',
  forgejoPublicUrl: 'http://git.test',
  blueprintsDir: fileURLToPath(new URL('../../../blueprints', import.meta.url)),
  pipelinesDir: fileURLToPath(new URL('../../../pipelines', import.meta.url)),
  toolsApiUrl: 'http://api.tools.test',
  webhookSecretKey: 'test-webhook-secret-key-that-is-long-enough',
  signingKeySecret: 'test-signing-key-secret-that-is-long-enough',
  buildWorkDir: join(tmpdir(), 'dreamdevops-test-builds'),
  buildTimeoutMinutes: 60,
  imageRunnerLabel: 'test-image-runner',
  agentApiUrl: 'http://api.test',
  agentChart: 'oci://charts.test/dreamdevops-agent',
  targetLostAfterSeconds: 180,
  demoData: false,
  provisioningMaxAttempts: 3,
  provisioningRetrySeconds: 1,
  smtpHost: 'unused',
  smtpPort: 25,
  smtpFrom: 'DreamDevOps <no-reply@example.com>',
  smtpSecurity: 'none',
  smtpUsername: null,
  smtpPassword: null,
  webhookAllowInsecure: false,
  webhookAllowPrivateNetworks: false,
  notificationRetrySeconds: 1,
  ...overrides,
});

export interface TestAppOptions {
  readonly config?: Partial<AppConfig>;
  readonly controllers?: readonly Type<unknown>[];
  readonly overrides?: readonly Provider[];
  /** Runs the outbox relay and job queue, which need a real database. */
  readonly background?: boolean;
}

/** Builds the real application from explicit providers. */
export async function buildApp(options: TestAppOptions): Promise<INestApplication> {
  const config = testConfig(options.config);
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({
      config,
      controllers: options.controllers ?? [],
      overrides: [
        ...(options.background ? [] : [{ provide: BACKGROUND_PROCESSING, useClass: NoBackgroundProcessing }]),
        { provide: MAILER, useValue: new FakeMailer() },
        { provide: SOURCE_HOST, useValue: new FakeSourceHost() },
        { provide: IMAGE_REGISTRY, useValue: new FakeImageRegistry() },
        { provide: PIPELINE_HOST, useValue: new FakePipelineHost() },
        ...(options.overrides ?? []),
      ],
    }),
    { bodyParser: false, rawBody: true, logger: false },
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
