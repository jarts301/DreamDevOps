import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type pg from 'pg';
import { NotificationsModule } from '../notifications/notifications.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { PostgresSessionStore } from '../session/postgres-session-store.ts';
import { SESSION_STORE } from '../session/session-store.ts';
import { DATABASE_POOL } from '../tokens.ts';
import { CompanyAccessService } from './application/company-access.service.ts';
import { IDENTITY_PROVIDER, USER_DIRECTORY } from './application/ports.ts';
import { AuthController } from './http/auth.controller.ts';
import { CompanyAccessController, InvitationsController } from './http/company-access.controller.ts';
import { KeycloakIdentityProvider } from './infrastructure/keycloak-identity-provider.ts';
import { PostgresUserDirectory } from './infrastructure/postgres-user-directory.ts';

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
              provide: CompanyAccessService,
              useFactory: (database: TenantDatabase, pool: pg.Pool) =>
                new CompanyAccessService(database, pool, { requireVerifiedEmail: config.requireVerifiedEmail }),
              inject: [TenantDatabase, DATABASE_POOL],
            },
          ],
          settings.overrides,
        ),
        // Sessions and users are what every request's guards need.
        exports: [SESSION_STORE, USER_DIRECTORY, CompanyAccessService],
      };
    });
  }
}
