import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { configureApp } from './configure-app.js';

const config = loadConfig(process.env);
const app = await NestFactory.create(AppModule.forRoot(config));
configureApp(app);
await app.listen(config.port, '0.0.0.0');
