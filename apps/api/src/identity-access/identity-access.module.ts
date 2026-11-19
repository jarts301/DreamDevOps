import { type DynamicModule, Inject, Injectable, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ALL_PERMISSIONS } from '@dreamdevops/contracts/permissions';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { NotificationsModule } from '../notifications/notifications.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { CompanyAccessService } from './application/company-access.service.ts';
import { AUTHENTICATOR, COMPANY_MEMBERS, FIRST_ADMIN_INVITATIONS } from '@dreamdevops/contracts/identity-access/services';
import { Authenticator } from './application/authenticator.ts';
import { MemberDirectory } from './application/member-directory.ts';
import { PermissionDefaults } from './application/permission-defaults.ts';
import {
  IDENTITY_PROVIDER,
  type IdentityProvider,
  MEMBERSHIP_STORE,
  type MembershipStore,
  PERMISSION_STORE,
  type PermissionStore,
  USER_DIRECTORY,
  type UserDirectory,
} from './application/ports.ts';
import { SESSION_STORE, type SessionStore } from './application/sessions.ts';
import { SignIn } from './application/sign-in.ts';
import { AuthController } from './http/auth.controller.ts';
import { CompanyAccessController, InvitationsController } from './http/company-access.controller.ts';
import { KeycloakIdentityProvider } from './infrastructure/keycloak-identity-provider.ts';
import { postgresMembershipStore } from './infrastructure/postgres-membership-store.ts';
import { PostgresPermissionStore } from './infrastructure/postgres-permission-store.ts';
import { PostgresSessionStore } from './infrastructure/postgres-session-store.ts';
import { PostgresUserDirectory } from './infrastructure/postgres-user-directory.ts';
import { INVITATION_MAILER, type InvitationMailer } from '@dreamdevops/contracts/notifications/services';

/** Gives roles the permissions contexts declare for them, when the API starts, before it takes requests. */
@Injectable()
class PermissionDefaultsOnStart implements OnApplicationBootstrap {
  readonly #defaults: PermissionDefaults;

  constructor(@Inject(PermissionDefaults) defaults: PermissionDefaults) {
    this.#defaults = defaults;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.#defaults.apply();
  }
}

/** Login, sessions, and who belongs to which company with which role. */
@Module({})
export class IdentityAccessModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, IdentityAccessModule, () => {
      const { config } = settings;
      return {
        module: IdentityAccessModule,
        imports: [NotificationsModule.register(settings)],
        controllers: [AuthController, CompanyAccessController, InvitationsController],
        providers: withOverrides(
          [
            {
              provide: SESSION_STORE,
              useFactory: (database: TenantDatabase) => new PostgresSessionStore(database.acrossCompanies({ role: 'dreamdevops_identity' })),
              inject: [TenantDatabase],
            },
            {
              provide: IDENTITY_PROVIDER,
              useFactory: () =>
                new KeycloakIdentityProvider({
                  issuerUrl: config.keycloakIssuerUrl,
                  clientId: config.keycloakClientId,
                  clientSecret: config.keycloakClientSecret,
                }),
            },
            {
              provide: USER_DIRECTORY,
              useFactory: (database: TenantDatabase) => new PostgresUserDirectory(database.acrossCompanies({ role: 'dreamdevops_identity' })),
              inject: [TenantDatabase],
            },
            {
              provide: SignIn,
              useFactory: (provider: IdentityProvider, directory: UserDirectory, sessions: SessionStore) =>
                new SignIn(provider, directory, sessions, {
                  publicUrl: config.publicUrl,
                  dashboardUrl: config.dashboardUrl,
                  session: { absoluteMs: config.sessionAbsoluteMs, idleMs: config.sessionIdleMs },
                }),
              inject: [IDENTITY_PROVIDER, USER_DIRECTORY, SESSION_STORE],
            },
            { provide: MEMBERSHIP_STORE, useFactory: postgresMembershipStore, inject: [TenantDatabase] },
            {
              provide: CompanyAccessService,
              useFactory: (store: MembershipStore, emails: InvitationMailer) =>
                new CompanyAccessService(store, emails, { requireVerifiedEmail: config.requireVerifiedEmail }),
              inject: [MEMBERSHIP_STORE, INVITATION_MAILER],
            },
            // Tenancy invites a new company's first admin through this.
            { provide: FIRST_ADMIN_INVITATIONS, useExisting: CompanyAccessService },
            {
              provide: COMPANY_MEMBERS,
              useFactory: (store: MembershipStore) => new MemberDirectory(store),
              inject: [MEMBERSHIP_STORE],
            },
            {
              provide: Authenticator,
              useFactory: (sessions: SessionStore, directory: UserDirectory) => new Authenticator(sessions, directory, { idleMs: config.sessionIdleMs }),
              inject: [SESSION_STORE, USER_DIRECTORY],
            },
            // The platform's guards find who each request is from through this.
            { provide: AUTHENTICATOR, useExisting: Authenticator },
            {
              provide: PERMISSION_STORE,
              useFactory: (database: TenantDatabase) => new PostgresPermissionStore(database.acrossCompanies({ role: 'dreamdevops_identity' })),
              inject: [TenantDatabase],
            },
            {
              provide: PermissionDefaults,
              useFactory: (store: PermissionStore) => new PermissionDefaults(store, ALL_PERMISSIONS, new Logger(PermissionDefaults.name)),
              inject: [PERMISSION_STORE],
            },
            PermissionDefaultsOnStart,
          ],
          settings.overrides,
        ),
        // The guards find who each request is from through AUTHENTICATOR. Other contexts, such
        // as Alerts, learn who belongs to the company through COMPANY_MEMBERS. The demo, which
        // the platform puts together, uses the user directory and CompanyAccessService.
        exports: [AUTHENTICATOR, USER_DIRECTORY, CompanyAccessService, COMPANY_MEMBERS, FIRST_ADMIN_INVITATIONS],
      };
    });
  }
}
