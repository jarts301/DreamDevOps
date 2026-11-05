import { type INestApplication, ValidationPipe } from '@nestjs/common';

/** Settings shared by the server and the end-to-end tests, so tests run what actually runs. */
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
}
