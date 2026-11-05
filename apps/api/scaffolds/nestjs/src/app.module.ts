import { type DynamicModule, Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { CONFIG, type Config } from './config.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { NotesModule } from './notes/notes.module.js';

@Module({})
export class AppModule {
  static forRoot(config: Config): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DatabaseModule, NotesModule],
      controllers: [AppController, HealthController],
      providers: [{ provide: CONFIG, useValue: config }],
      exports: [CONFIG],
    };
  }
}
