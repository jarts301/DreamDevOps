import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import pg from 'pg';
import { APP_CONFIG, DATABASE_POOL } from '../tokens.ts';
import { type ModuleSettings, withOverrides } from './module-settings.ts';

/**
 * What every module shares: the settings and the database. It's global, so modules use
 * it without importing it, and Nest shuts it down last, after every module that uses
 * the database has stopped.
 */
@Module({})
export class PlatformModule implements OnApplicationShutdown {
  readonly #pool: pg.Pool;

  constructor(@Inject(DATABASE_POOL) pool: pg.Pool) {
    this.#pool = pool;
  }

  static register({ config, overrides }: ModuleSettings): DynamicModule {
    return {
      module: PlatformModule,
      global: true,
      providers: withOverrides(
        [
          { provide: APP_CONFIG, useValue: config },
          { provide: DATABASE_POOL, useFactory: () => new pg.Pool({ connectionString: config.databaseUrl }) },
          { provide: TenantDatabase, useFactory: (pool: pg.Pool) => new TenantDatabase(pool), inject: [DATABASE_POOL] },
        ],
        overrides,
      ),
      exports: [APP_CONFIG, DATABASE_POOL, TenantDatabase],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#pool.end();
  }
}
