import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { ApplicationCatalog } from '../catalog/application/application-catalog.ts';
import { CatalogModule } from '../catalog/catalog.module.ts';
import { RUNNING_ENVIRONMENTS, type RunningEnvironments } from '../environments/application/running-environments.ts';
import { EnvironmentsModule } from '../environments/environments.module.ts';
import { LATEST_METRICS, type LatestMetrics } from '../monitoring/application/latest-metrics.ts';
import { MonitoringModule } from '../monitoring/monitoring.module.ts';
import { AlertEmails } from '../notifications/application/alert-emails.ts';
import { NotificationsModule } from '../notifications/notifications.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { COMPANY_DIRECTORY, type CompanyDirectory } from '../tenancy/application/company-directory.ts';
import { CompanyDirectoryModule } from '../tenancy/company-directory.module.ts';
import { AlertChecks } from './application/alert-checks.ts';
import { AlertDeliveries } from './application/alert-deliveries.ts';
import { AlertRules } from './application/alert-rules.ts';
import { Places } from './application/places.ts';
import { AlertsController } from './http/alerts.controller.ts';
import { AlertsSubscriptions } from './messaging/alerts-subscriptions.ts';

/**
 * Alerts on what runs in each company's environments: each watches one metric of one
 * environment, and emails the addresses it names when the metric crosses its threshold
 * for long enough, and when it's back. It reads the metrics through Monitoring, names
 * places through Environments and the catalog, and emails through Notifications.
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
              useFactory: (environments: RunningEnvironments, catalog: ApplicationCatalog) => new Places(environments, catalog),
              inject: [RUNNING_ENVIRONMENTS, ApplicationCatalog],
            },
            {
              provide: AlertRules,
              useFactory: (database: TenantDatabase, places: Places, metrics: LatestMetrics, emails: AlertEmails) =>
                new AlertRules(database, places, metrics, emails),
              inject: [TenantDatabase, Places, LATEST_METRICS, AlertEmails],
            },
            {
              provide: AlertChecks,
              useFactory: (database: TenantDatabase, companies: CompanyDirectory, places: Places, metrics: LatestMetrics) =>
                new AlertChecks(database, companies, places, metrics),
              inject: [TenantDatabase, COMPANY_DIRECTORY, Places, LATEST_METRICS],
            },
            {
              provide: AlertDeliveries,
              useFactory: (database: TenantDatabase, companies: CompanyDirectory, emails: AlertEmails) =>
                new AlertDeliveries(database, companies, emails),
              inject: [TenantDatabase, COMPANY_DIRECTORY, AlertEmails],
            },
            {
              provide: AlertsSubscriptions,
              useFactory: (checks: AlertChecks, deliveries: AlertDeliveries) => new AlertsSubscriptions(checks, deliveries, config),
              inject: [AlertChecks, AlertDeliveries],
            },
          ],
          settings.overrides,
        ),
        exports: [AlertsSubscriptions],
      };
    });
  }
}
