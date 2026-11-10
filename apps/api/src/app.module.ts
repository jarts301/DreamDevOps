import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module.ts';
import { BackgroundModule } from './background/background.module.ts';
import { BlueprintsModule } from './blueprints/blueprints.module.ts';
import { BuildsModule } from './builds/builds.module.ts';
import { CatalogModule } from './catalog/catalog.module.ts';
import type { AppConfig } from './config/app-config.ts';
import type { EntitlementProvider } from './editions/application/ports.ts';
import { EditionsModule } from './editions/editions.module.ts';
import { EnvironmentsModule } from './environments/environments.module.ts';
import { FeatureGuard } from './editions/http/feature.guard.ts';
import { HealthController } from './health/health.controller.ts';
import { AuthorizationGuard, OriginGuard, SessionGuard } from './http/guards.ts';
import { ProblemDetailsFilter } from './http/problem-details.filter.ts';
import { TenantContextInterceptor } from './http/tenant-context.interceptor.ts';
import { AuthController } from './identity-access/http/auth.controller.ts';
import { InvitationsController } from './identity-access/http/company-access.controller.ts';
import { IdentityAccessModule } from './identity-access/identity-access.module.ts';
import { NotificationsModule } from './notifications/notifications.module.ts';
import type { ModuleSettings } from './platform/module-settings.ts';
import { tokenOf } from './platform/module-settings.ts';
import { PlatformModule } from './platform/platform.module.ts';
import { SourceGovernanceModule } from './source-governance/source-governance.module.ts';
import { CompanyDirectoryModule } from './tenancy/company-directory.module.ts';
import { TenancyModule } from './tenancy/tenancy.module.ts';

const MINUTE_MS = 60_000;

export interface AppModuleOptions {
  readonly config: AppConfig;
  /** Feature controllers. Tests use this to add sample routes. */
  readonly controllers?: readonly Type<unknown>[];
  /** Replaces providers, such as the database, for tests that don't need the real one. */
  readonly overrides?: readonly Provider[];
  /**
   * Decides which commercial features each company has. The Commercial Edition passes
   * its own provider here. Without one, the free Community provider is used.
   */
  readonly entitlementProvider?: EntitlementProvider;
}

/**
 * Puts the application together. Each bounded context is its own Nest module, which
 * states what it needs from other contexts and what it offers them. That keeps every
 * dependency between contexts visible, so any context can later become its own service.
 */
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const { config } = options;
    const settings: ModuleSettings = { config, overrides: options.overrides ?? [] };
    const modules = [
      PlatformModule.register(settings),
      IdentityAccessModule.register(settings),
      TenancyModule.register(settings),
      CompanyDirectoryModule.register(settings),
      AuditModule.register(settings),
      NotificationsModule.register(settings),
      EditionsModule.register(settings, options.entitlementProvider),
      BlueprintsModule.register(settings),
      CatalogModule.register(settings),
      SourceGovernanceModule.register(settings),
      BuildsModule.register(settings),
      EnvironmentsModule.register(settings),
      BackgroundModule.register(settings),
    ];
    // Replacements for tokens no module provides are added here, as they always were.
    const provided = new Set(modules.flatMap((module) => (module.providers ?? []).map(tokenOf)));
    const unclaimed = settings.overrides.filter((override) => !provided.has(tokenOf(override)));

    return {
      module: AppModule,
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [
            { name: 'default', ttl: MINUTE_MS, limit: config.rateLimitPerMinute },
            {
              name: 'auth',
              ttl: MINUTE_MS,
              limit: config.authRateLimitPerMinute,
              skipIf: (context) => {
                const controller = context.getClass();
                return controller !== AuthController && controller !== InvitationsController;
              },
            },
          ],
        }),
        ...modules,
      ],
      controllers: [HealthController, ...(options.controllers ?? [])],
      providers: [
        // Guards run in this order, so rate limits apply before any database work.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: OriginGuard },
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: APP_GUARD, useClass: AuthorizationGuard },
        { provide: APP_GUARD, useClass: FeatureGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        ...unclaimed,
      ],
    };
  }
}
