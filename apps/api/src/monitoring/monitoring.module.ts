import { type DynamicModule, Module } from '@nestjs/common';
import { ApplicationCatalog } from '../catalog/application/application-catalog.ts';
import { CatalogModule } from '../catalog/catalog.module.ts';
import { ENVIRONMENT_LOGS, type EnvironmentLogs } from '../environments/application/environment-logs.ts';
import { RUNNING_ENVIRONMENTS, type RunningEnvironments } from '../environments/application/running-environments.ts';
import { EnvironmentsModule } from '../environments/environments.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { ApplicationLogs } from './application/application-logs.ts';
import { ApplicationMetrics } from './application/application-metrics.ts';
import { ApplicationTraces } from './application/application-traces.ts';
import { METRICS_STORE, type MetricsStore, TRACE_STORE, type TraceStore } from './application/ports.ts';
import { MonitoringController } from './http/monitoring.controller.ts';
import { JaegerTraceStore } from './infrastructure/jaeger-trace-store.ts';
import { PrometheusMetricsStore } from './infrastructure/prometheus-metrics-store.ts';

/**
 * The metrics, logs and traces of what runs in each company's environments. Applications
 * send metrics and traces over OpenTelemetry, to a metrics store and a trace store, and
 * Environments reads what they write. It learns what runs where from Environments.
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
              provide: TRACE_STORE,
              useFactory: (): TraceStore | null => (config.jaegerUrl === null ? null : new JaegerTraceStore({ url: config.jaegerUrl })),
            },
            {
              provide: ApplicationLogs,
              useFactory: (environments: RunningEnvironments, logs: EnvironmentLogs) => new ApplicationLogs(environments, logs),
              inject: [RUNNING_ENVIRONMENTS, ENVIRONMENT_LOGS],
            },
            {
              provide: ApplicationTraces,
              useFactory: (environments: RunningEnvironments, catalog: ApplicationCatalog, store: TraceStore | null) =>
                new ApplicationTraces(environments, catalog, store),
              inject: [RUNNING_ENVIRONMENTS, ApplicationCatalog, TRACE_STORE],
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
