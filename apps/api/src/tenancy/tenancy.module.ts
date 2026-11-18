import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { FIRST_ADMIN_INVITATIONS, type FirstAdminInvitations } from '@dreamdevops/contracts/identity-access/services';
import { IdentityAccessModule } from '../identity-access/identity-access.module.ts';
import { NotificationsModule } from '../notifications/notifications.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { CompaniesService } from './application/companies.service.ts';
import { GIT_PROVIDER, type GitProvider } from './application/ports.ts';
import { ProvisioningSaga } from './application/provisioning.ts';
import { CompanyDirectoryModule } from './company-directory.module.ts';
import { CompaniesController } from './http/companies.controller.ts';
import { ForgejoGitProvider } from './infrastructure/forgejo-git-provider.ts';
import { TenancySubscriptions } from './messaging/tenancy-subscriptions.ts';

/** The company register, and each company's resources, such as its Git organization. */
@Module({})
export class TenancyModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, TenancyModule, () => {
      const { config } = settings;
      return {
        module: TenancyModule,
        imports: [
          CompanyDirectoryModule.register(settings),
          IdentityAccessModule.register(settings),
          NotificationsModule.register(settings),
        ],
        controllers: [CompaniesController],
        providers: withOverrides(
          [
            {
              provide: CompaniesService,
              useFactory: (database: TenantDatabase, invitations: FirstAdminInvitations) => new CompaniesService(database, invitations),
              inject: [TenantDatabase, FIRST_ADMIN_INVITATIONS],
            },
            {
              provide: GIT_PROVIDER,
              useFactory: () =>
                new ForgejoGitProvider({
                  url: config.forgejoUrl,
                  username: config.forgejoUsername,
                  password: config.forgejoPassword,
                }),
            },
            {
              provide: ProvisioningSaga,
              useFactory: (database: TenantDatabase, git: GitProvider) =>
                new ProvisioningSaga(database, git, { maxAttempts: config.provisioningMaxAttempts }),
              inject: [TenantDatabase, GIT_PROVIDER],
            },
            {
              provide: TenancySubscriptions,
              useFactory: (saga: ProvisioningSaga) => new TenancySubscriptions(saga, config),
              inject: [ProvisioningSaga],
            },
          ],
          settings.overrides,
        ),
        // The local demo company is created through the same service people use.
        exports: [CompaniesService, TenancySubscriptions],
      };
    });
  }
}
