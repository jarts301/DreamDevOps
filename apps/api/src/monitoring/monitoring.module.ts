import { type DynamicModule, Module } from '@nestjs/common';
import { ApplicationCatalog } from '../catalog/application/application-catalog.ts';
import { CatalogModule } from '../catalog/catalog.module.ts';
import { RUNNING_ENVIRONMENTS, type RunningEnvironments } from '../environments/application/running-environments.ts';
import { EnvironmentsModule } from '../environments/environments.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { ApplicationMetrics } from './application/application-metrics.ts';
import { METRICS_STORE, type MetricsStore } from './application/ports.ts';
import { MonitoringController } from './http/monitoring.controller.ts';
import { PrometheusMetricsStore } from './infrastructure/prometheus-metrics-store.ts';

/**
 * The metrics of what runs in each company's environments, which applications send over
 * OpenTelemetry to a metrics store. It learns what runs where from Environments.
 */
@Module({})
export class MonitoringModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, MonitoringModule, () => {
      const { config } = settings;
      return {
        module: MonitoringModule,
        imports: [CatalogModule.register(settings), EnvironmentsModule.register(settings)],
        controllers: [MonitoringController],
        providers: withOverrides(
          [
            // Without a store, the dashboard says metrics aren't set up, and everything else works.
            {
              provide: METRICS_STORE,
              useFactory: (): MetricsStore | null =>
                config.prometheusUrl === null ? null : new PrometheusMetricsStore({ url: config.prometheusUrl }),
            },
            {
              provide: ApplicationMetrics,
              useFactory: (environments: RunningEnvironments, catalog: ApplicationCatalog, store: MetricsStore | null) =>
                new ApplicationMetrics(environments, catalog, store),
              inject: [RUNNING_ENVIRONMENTS, ApplicationCatalog, METRICS_STORE],
            },
          ],
          settings.overrides,
        ),
      };
    });
  }
}
