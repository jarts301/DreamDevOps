import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { AppConfig } from './config/app-config.ts';

const MAX_BODY_SIZE = '1mb';

/** Settings shared by the real server and the tests, so tests exercise what actually runs. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.set('trust proxy', config.trustedProxies);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  // The app is created with rawBody, so JSON requests keep their exact bytes too, which
  // webhook signatures cover.
  app.useBodyParser('json', { limit: MAX_BODY_SIZE });
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
}
