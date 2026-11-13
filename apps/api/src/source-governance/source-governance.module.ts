import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { BLUEPRINT_CATALOG, type BlueprintCatalog } from '../blueprints/application/blueprint-catalog.ts';
import { BlueprintsModule } from '../blueprints/blueprints.module.ts';
import { ApplicationCatalog } from '../catalog/application/application-catalog.ts';
import { CatalogModule } from '../catalog/catalog.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { COMPANY_DIRECTORY, type CompanyDirectory } from '../tenancy/application/company-directory.ts';
import { CompanyDirectoryModule } from '../tenancy/company-directory.module.ts';
import { SOURCE_HOST, type SourceHost } from './application/ports.ts';
import { Repositories } from './application/repositories.ts';
import { REPOSITORY_LOOKUP } from './application/repository-lookup.ts';
import { SourceAccess } from './application/source-access.ts';
import { SourceController } from './http/source.controller.ts';
import { ForgejoSourceHost } from './infrastructure/forgejo-source-host.ts';
import { webhookSecret } from '../webhooks/domain/signature.ts';
import { SourceGovernanceSubscriptions } from './messaging/source-governance-subscriptions.ts';

/** Each application's repository, its Git Flow rules, and the teams that can use it. */
@Module({})
export class SourceGovernanceModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, SourceGovernanceModule, () => {
      const { config } = settings;
      return {
        module: SourceGovernanceModule,
        imports: [
          BlueprintsModule.register(settings),
          CatalogModule.register(settings),
          CompanyDirectoryModule.register(settings),
        ],
        controllers: [SourceController],
        providers: withOverrides(
          [
            {
              provide: SOURCE_HOST,
              useFactory: () =>
                new ForgejoSourceHost({
                  url: config.forgejoUrl,
                  username: config.forgejoUsername,
                  password: config.forgejoPassword,
                }),
            },
            {
              provide: Repositories,
              useFactory: (
                database: TenantDatabase,
                companies: CompanyDirectory,
                host: SourceHost,
                catalog: ApplicationCatalog,
                blueprints: BlueprintCatalog,
              ) =>
                new Repositories(database, companies, host, catalog, blueprints, {
                  maxAttempts: config.provisioningMaxAttempts,
                  publicUrl: config.forgejoPublicUrl,
                  // Each repository tells the webhook gateway about pushes and pull requests.
                  webhookUrl: `${config.toolsApiUrl}/api/v1/webhooks/forgejo`,
                  webhookSecret: (applicationId) => webhookSecret(config.webhookSecretKey, applicationId),
                }),
              inject: [TenantDatabase, COMPANY_DIRECTORY, SOURCE_HOST, ApplicationCatalog, BLUEPRINT_CATALOG],
            },
            { provide: REPOSITORY_LOOKUP, useExisting: Repositories },
            {
              provide: SourceAccess,
              useFactory: (database: TenantDatabase, companies: CompanyDirectory, host: SourceHost) =>
                new SourceAccess(database, companies, host, config.forgejoPublicUrl),
              inject: [TenantDatabase, COMPANY_DIRECTORY, SOURCE_HOST],
            },
            {
              provide: SourceGovernanceSubscriptions,
              useFactory: (repositories: Repositories, access: SourceAccess, database: TenantDatabase) =>
                new SourceGovernanceSubscriptions(repositories, access, config, database),
              inject: [Repositories, SourceAccess, TenantDatabase],
            },
          ],
          settings.overrides,
        ),
        // Other modules find repositories only through the RepositoryLookup interface, and
        // drive Git, such as for builds and releases, through the source host port.
        exports: [REPOSITORY_LOOKUP, SOURCE_HOST, SourceGovernanceSubscriptions],
      };
    });
  }
}
