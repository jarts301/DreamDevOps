import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import helmet from 'helmet';
import type { AppConfig } from './config/app-config.ts';

const MAX_BODY_SIZE = '1mb';
const MAX_TELEMETRY_SIZE = '8mb';

/**
 * How the application is created, shared by the real server and the tests. Bodies are
 * parsed by configureApp, and each one's raw bytes are kept, because webhook signatures
 * cover the exact bytes sent.
 */
export const APP_CREATION_OPTIONS = { bodyParser: false, rawBody: true } as const;

/** Settings shared by the real server and the tests, so tests exercise what actually runs. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.set('trust proxy', config.trustedProxies);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  // Targets' collectors send telemetry in batches, so their JSON may be larger. Gzip is unpacked first.
  app.use('/api/v1/telemetry', json({ limit: MAX_TELEMETRY_SIZE }));
  app.useBodyParser('json', { limit: MAX_BODY_SIZE });
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
}
