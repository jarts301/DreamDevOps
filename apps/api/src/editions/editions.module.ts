import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { COMPANY_DIRECTORY, type CompanyDirectory } from '@dreamdevops/contracts/tenancy/services';
import { CompanyDirectoryModule } from '../tenancy/company-directory.module.ts';
import { FEATURE_ACCESS } from '@dreamdevops/contracts/editions/services';
import { Entitlements } from './application/entitlements.ts';
import { ENTITLEMENT_PROVIDER, type EntitlementProvider } from './application/ports.ts';
import { EditionsController } from './http/editions.controller.ts';
import { CommunityEntitlementProvider } from './infrastructure/community-entitlement-provider.ts';

/** Which edition each company is on, and so which features it has. */
@Module({})
export class EditionsModule {
  /**
   * The Commercial Edition passes its own entitlement provider. Without one, the free
   * Community provider is used.
   */
  static register(settings: ModuleSettings, entitlementProvider?: EntitlementProvider): DynamicModule {
    return registerOnce(settings, EditionsModule, () => ({
      module: EditionsModule,
      imports: [CompanyDirectoryModule.register(settings)],
      controllers: [EditionsController],
      providers: withOverrides(
        [
          { provide: ENTITLEMENT_PROVIDER, useValue: entitlementProvider ?? new CommunityEntitlementProvider() },
          {
            provide: Entitlements,
            useFactory: (database: TenantDatabase, companies: CompanyDirectory, provider: EntitlementProvider) =>
              new Entitlements(database, companies, provider),
            inject: [TenantDatabase, COMPANY_DIRECTORY, ENTITLEMENT_PROVIDER],
          },
          // What other contexts ask whether a company's edition includes a feature.
          { provide: FEATURE_ACCESS, useExisting: Entitlements },
        ],
        settings.overrides,
      ),
      // Entitlements is for every request's feature check, which the platform runs; contexts use FEATURE_ACCESS.
      exports: [Entitlements, FEATURE_ACCESS],
    }));
  }
}
