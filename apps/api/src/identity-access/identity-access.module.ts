import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type pg from 'pg';
import { NotificationsModule } from '../notifications/notifications.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { PostgresSessionStore } from '../session/postgres-session-store.ts';
import { SESSION_STORE, type SessionStore } from '../session/session-store.ts';
import { DATABASE_POOL } from '../tokens.ts';
import { CompanyAccessService } from './application/company-access.service.ts';
import { COMPANY_MEMBERS, FIRST_ADMIN_INVITATIONS } from '@dreamdevops/contracts/identity-access/services';
import { MemberDirectory } from './application/member-directory.ts';
import {
  IDENTITY_PROVIDER,
  type IdentityProvider,
  MEMBERSHIP_STORE,
  type MembershipStore,
  USER_DIRECTORY,
  type UserDirectory,
} from './application/ports.ts';
import { SignIn } from './application/sign-in.ts';
import { AuthController } from './http/auth.controller.ts';
import { CompanyAccessController, InvitationsController } from './http/company-access.controller.ts';
import { KeycloakIdentityProvider } from './infrastructure/keycloak-identity-provider.ts';
import { postgresMembershipStore } from './infrastructure/postgres-membership-store.ts';
import { PostgresUserDirectory } from './infrastructure/postgres-user-directory.ts';
import { INVITATION_MAILER, type InvitationMailer } from '@dreamdevops/contracts/notifications/services';

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
              useFactory: (pool: pg.Pool) => new PostgresSessionStore(pool),
              inject: [DATABASE_POOL],
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
              useFactory: (pool: pg.Pool) => new PostgresUserDirectory(pool),
              inject: [DATABASE_POOL],
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
            { provide: MEMBERSHIP_STORE, useFactory: postgresMembershipStore, inject: [TenantDatabase, DATABASE_POOL] },
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
          ],
          settings.overrides,
        ),
        // Sessions and users are what every request's guards need. Other contexts, such as
        // Alerts, learn who belongs to the company through COMPANY_MEMBERS.
        exports: [SESSION_STORE, USER_DIRECTORY, CompanyAccessService, COMPANY_MEMBERS, FIRST_ADMIN_INVITATIONS],
      };
    });
  }
}
