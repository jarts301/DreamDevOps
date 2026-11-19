import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { COMPANY_DIRECTORY } from '@dreamdevops/contracts/tenancy/services';
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
              // Companies are looked up across companies, as Tenancy's own role.
              useFactory: (database: TenantDatabase) => new PostgresCompanyDirectory(database.acrossCompanies({ role: 'dreamdevops_tenancy' })),
              inject: [TenantDatabase],
            },
          ],
          overrides,
        ),
        exports: [COMPANY_DIRECTORY],
      };
    });
  }
}
