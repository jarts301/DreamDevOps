import { type DynamicModule, Module } from '@nestjs/common';
import type pg from 'pg';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { DATABASE_POOL } from '../tokens.ts';
import { COMPANY_DIRECTORY } from './application/company-directory.ts';
import { PostgresCompanyDirectory } from './infrastructure/postgres-company-directory.ts';

/**
 * Tenancy's published read model, in a module of its own, so other modules can ask about
 * companies without depending on the rest of Tenancy.
 */
@Module({})
export class CompanyDirectoryModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, CompanyDirectoryModule, () => {
      const { overrides } = settings;
      return {
        module: CompanyDirectoryModule,
        providers: withOverrides(
          [
            {
              provide: COMPANY_DIRECTORY,
              useFactory: (pool: pg.Pool) => new PostgresCompanyDirectory(pool),
              inject: [DATABASE_POOL],
            },
          ],
          overrides,
        ),
        exports: [COMPANY_DIRECTORY],
      };
    });
  }
}
