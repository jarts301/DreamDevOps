import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { APPLICATION_DIRECTORY, type ApplicationDirectory } from '@dreamdevops/contracts/catalog/services';
import { CatalogModule } from '../catalog/catalog.module.ts';
import { ENVIRONMENT_DIRECTORY, type EnvironmentDirectory } from '@dreamdevops/contracts/environments/services';
import { EnvironmentsModule } from '../environments/environments.module.ts';
import { COMPANY_MEMBERS, type CompanyMembers } from '@dreamdevops/contracts/identity-access/services';
import { IdentityAccessModule } from '../identity-access/identity-access.module.ts';
import { LATEST_METRICS, type LatestMetrics } from '@dreamdevops/contracts/monitoring/services';
import { MonitoringModule } from '../monitoring/monitoring.module.ts';
import { ALERT_MAILER, type AlertMailer } from '@dreamdevops/contracts/notifications/services';
import { NotificationsModule } from '../notifications/notifications.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { COMPANY_DIRECTORY, type CompanyDirectory } from '@dreamdevops/contracts/tenancy/services';
import { CompanyDirectoryModule } from '../tenancy/company-directory.module.ts';
import { AlertChecks } from './application/alert-checks.ts';
import { AlertDeliveries } from './application/alert-deliveries.ts';
import { AlertRules } from './application/alert-rules.ts';
import { Places } from './application/places.ts';
import { AlertsController } from './http/alerts.controller.ts';
import { AlertsSubscriptions } from './messaging/alerts-subscriptions.ts';

/**
 * Alerts on what runs in each company's environments: each watches one metric of one
 * application in one environment, and emails the members it names when the metric crosses its threshold for
 * long enough, and when it's back. It reads the metrics through Monitoring, names places
 * through EnvironmentDirectory and the catalog, finds members through Identity, and emails
 * through Notifications.
 */
@Module({})
export class AlertsModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, AlertsModule, () => {
      const { config } = settings;
      return {
        module: AlertsModule,
        imports: [
          CompanyDirectoryModule.register(settings),
          IdentityAccessModule.register(settings),
          CatalogModule.register(settings),
          EnvironmentsModule.register(settings),
          MonitoringModule.register(settings),
          NotificationsModule.register(settings),
        ],
        controllers: [AlertsController],
        providers: withOverrides(
          [
            {
              provide: Places,
              useFactory: (environments: EnvironmentDirectory, catalog: ApplicationDirectory) => new Places(environments, catalog),
              inject: [ENVIRONMENT_DIRECTORY, APPLICATION_DIRECTORY],
            },
            {
              provide: AlertRules,
              useFactory: (database: TenantDatabase, places: Places, metrics: LatestMetrics, emails: AlertMailer, members: CompanyMembers) =>
                new AlertRules(database, places, metrics, emails, members),
              inject: [TenantDatabase, Places, LATEST_METRICS, ALERT_MAILER, COMPANY_MEMBERS],
            },
            {
              provide: AlertChecks,
              useFactory: (database: TenantDatabase, companies: CompanyDirectory, places: Places, metrics: LatestMetrics) =>
                new AlertChecks(database, companies, places, metrics),
              inject: [TenantDatabase, COMPANY_DIRECTORY, Places, LATEST_METRICS],
            },
            {
              provide: AlertDeliveries,
              useFactory: (database: TenantDatabase, companies: CompanyDirectory, emails: AlertMailer, members: CompanyMembers) =>
                new AlertDeliveries(database, companies, emails, members),
              inject: [TenantDatabase, COMPANY_DIRECTORY, ALERT_MAILER, COMPANY_MEMBERS],
            },
            {
              provide: AlertsSubscriptions,
              useFactory: (checks: AlertChecks, deliveries: AlertDeliveries, rules: AlertRules) =>
                new AlertsSubscriptions(checks, deliveries, rules, config),
              inject: [AlertChecks, AlertDeliveries, AlertRules],
            },
          ],
          settings.overrides,
        ),
        exports: [AlertsSubscriptions],
      };
    });
  }
}
