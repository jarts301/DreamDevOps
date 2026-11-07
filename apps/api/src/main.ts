import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.ts';
import { loadConfig } from './config/app-config.ts';
import { configureApp } from './configure-app.ts';

const config = loadConfig(process.env);
const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot({ config }), {
  bodyParser: false,
  rawBody: true,
});
configureApp(app, config);
await app.listen(config.port, '127.0.0.1');
console.log(`API listening on ${config.publicUrl}`);
