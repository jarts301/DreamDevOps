import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import pg from 'pg';
import { CONFIG, type Config } from '../config.js';

/** A connection pool, or null when no database is configured. */
export const DATABASE = Symbol('DATABASE');
export type Database = pg.Pool | null;

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: (config: Config): Database =>
        config.databaseUrl === null
          ? null
          : new pg.Pool({ connectionString: config.databaseUrl }),
      inject: [CONFIG],
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async onApplicationShutdown(): Promise<void> {
    await this.database?.end();
  }
}
