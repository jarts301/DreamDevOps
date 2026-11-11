import { fileURLToPath } from 'node:url';
import type { INestApplication, Provider, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module.ts';
import { BACKGROUND_PROCESSING, NoBackgroundProcessing } from '../src/background/background-processing.ts';
import type { AppConfig } from '../src/config/app-config.ts';
import { APP_CREATION_OPTIONS, configureApp } from '../src/configure-app.ts';
import { IDENTITY_PROVIDER, USER_DIRECTORY } from '../src/identity-access/application/ports.ts';
import { SESSION_STORE } from '../src/session/session-store.ts';
import { DATABASE_POOL } from '../src/tokens.ts';
import { MAILER } from '../src/notifications/application/ports.ts';
import { SOURCE_HOST } from '../src/source-governance/application/ports.ts';
import {
  BUILD_SOURCE,
  IMAGE_BUILDER,
  IMAGE_REGISTRY,
  IMAGE_SCANNER,
} from '../src/builds/application/ports.ts';
import { IMAGE_SIGNING_KEY } from '../src/builds/application/tokens.ts';
import { HOST_RUNTIMES, SECRET_BOX } from '../src/environments/application/ports.ts';
import { SecretBox } from '../src/environments/domain/secret-box.ts';
import { SigningKey } from '../src/builds/domain/signature.ts';
import {
  FakeBuildSource,
  FakeHostRuntime,
  FakeIdentityProvider,
  FakeImageBuilder,
  FakeImageRegistry,
  FakeImageScanner,
  FakeMailer,
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
  forgejoWebhookUrl: 'http://api.test/api/v1/hooks/forgejo',
  forgejoWebhookSecret: 'fake-dummy-webhook-secret',
  registryUrl: 'http://registry.test',
  // Tests supply their own key, so this file is never read or created.
  imageSigningKeyFile: '/nonexistent/image-signing.key',
  imageScanner: 'trivy',
  trivyImage: 'unused',
  buildConcurrency: 1,
  buildTimeoutMs: 60_000,
  buildMaxAttempts: 3,
  buildRetrySeconds: 1,
  localHosting: true,
  localHostingBindAddress: '127.0.0.1',
  deployMaxAttempts: 2,
  deployRetrySeconds: 1,
  deployHealthTimeoutMs: 5_000,
  // Tests supply their own key, so this file is never read or created.
  secretsKeyFile: '/nonexistent/environment-secrets.key',
  prometheusUrl: null,
  appMetricsEndpoint: null,
  sampleData: null,
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
  const registry = new FakeImageRegistry();
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({
      config,
      controllers: options.controllers ?? [],
      overrides: [
        ...(options.background ? [] : [{ provide: BACKGROUND_PROCESSING, useClass: NoBackgroundProcessing }]),
        { provide: MAILER, useValue: new FakeMailer() },
        { provide: SOURCE_HOST, useValue: new FakeSourceHost() },
        { provide: IMAGE_SIGNING_KEY, useValue: SigningKey.generate().key },
        { provide: BUILD_SOURCE, useValue: new FakeBuildSource() },
        { provide: IMAGE_REGISTRY, useValue: registry },
        { provide: IMAGE_BUILDER, useValue: new FakeImageBuilder(registry) },
        { provide: IMAGE_SCANNER, useValue: new FakeImageScanner() },
        // Tests never run containers on the machine that runs them.
        { provide: HOST_RUNTIMES, useValue: [new FakeHostRuntime()] },
        { provide: SECRET_BOX, useValue: SecretBox.fromKeyText(SecretBox.generateKeyText()) },
        ...(options.overrides ?? []),
      ],
    }),
    { ...APP_CREATION_OPTIONS, logger: false },
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
