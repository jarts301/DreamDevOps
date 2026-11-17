import { type DynamicModule, Module } from '@nestjs/common';
import { ApplicationCatalog } from '../catalog/application/application-catalog.ts';
import { CatalogModule } from '../catalog/catalog.module.ts';
import { Environments } from '../environments/application/environments.ts';
import { EnvironmentsModule } from '../environments/environments.module.ts';
import { CompanyAccessService } from '../identity-access/application/company-access.service.ts';
import { USER_DIRECTORY, type UserDirectory } from '../identity-access/application/ports.ts';
import { IdentityAccessModule } from '../identity-access/identity-access.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { CompaniesService } from '../tenancy/application/companies.service.ts';
import { TenancyModule } from '../tenancy/tenancy.module.ts';
import { DemoCompany } from './demo-company.ts';

/** The local demo company, its users, one for each role, and its demo applications. Only on when demo data is. */
@Module({})
export class DemoModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, DemoModule, () => ({
      module: DemoModule,
      imports: [
        IdentityAccessModule.register(settings),
        TenancyModule.register(settings),
        CatalogModule.register(settings),
        EnvironmentsModule.register(settings),
      ],
      providers: settings.config.demoData
        ? withOverrides(
            [
              {
                provide: DemoCompany,
                useFactory: (
                  directory: UserDirectory,
                  companies: CompaniesService,
                  access: CompanyAccessService,
                  catalog: ApplicationCatalog,
                  environments: Environments,
                ) =>
                  new DemoCompany(
                    directory,
                    companies,
                    access,
                    settings.config.demoApplications ? { catalog, environments } : null,
                  ),
                inject: [USER_DIRECTORY, CompaniesService, CompanyAccessService, ApplicationCatalog, Environments],
              },
            ],
            settings.overrides,
          )
        : [],
    }));
  }
}
