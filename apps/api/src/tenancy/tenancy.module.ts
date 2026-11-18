import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { FIRST_ADMIN_INVITATIONS, type FirstAdminInvitations } from '@dreamdevops/contracts/identity-access/services';
import { IdentityAccessModule } from '../identity-access/identity-access.module.ts';
import { NotificationsModule } from '../notifications/notifications.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { CompaniesService } from './application/companies.service.ts';
import { GIT_PROVIDER, type GitProvider, TENANCY_STORE, type TenancyStore } from './application/ports.ts';
import { ProvisioningSaga } from './application/provisioning.ts';
import { CompanyDirectoryModule } from './company-directory.module.ts';
import { CompaniesController } from './http/companies.controller.ts';
import { ForgejoGitProvider } from './infrastructure/forgejo-git-provider.ts';
import { postgresTenancyStore } from './infrastructure/postgres-tenancy-store.ts';
import { INVITATION_MAILER, type InvitationMailer } from '@dreamdevops/contracts/notifications/services';
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
            { provide: TENANCY_STORE, useFactory: postgresTenancyStore, inject: [TenantDatabase] },
            {
              provide: CompaniesService,
              useFactory: (store: TenancyStore, invitations: FirstAdminInvitations, emails: InvitationMailer) =>
                new CompaniesService(store, invitations, emails),
              inject: [TENANCY_STORE, FIRST_ADMIN_INVITATIONS, INVITATION_MAILER],
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
              useFactory: (store: TenancyStore, git: GitProvider) =>
                new ProvisioningSaga(store, git, { maxAttempts: config.provisioningMaxAttempts }),
              inject: [TENANCY_STORE, GIT_PROVIDER],
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
