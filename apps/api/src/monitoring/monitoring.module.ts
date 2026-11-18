import { type DynamicModule, Module } from '@nestjs/common';
import { APPLICATION_DIRECTORY, type ApplicationDirectory } from '@dreamdevops/contracts/catalog/services';
import { CatalogModule } from '../catalog/catalog.module.ts';
import { RUNNING_VERSIONS, type RunningVersions } from '@dreamdevops/contracts/deployments/services';
import { DeploymentsModule } from '../deployments/deployments.module.ts';
import { TARGET_AUTHENTICATION, type TargetAuthentication } from '@dreamdevops/contracts/environments/services';
import { EnvironmentsModule } from '../environments/environments.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { ApplicationLogs } from './application/application-logs.ts';
import { ApplicationMetrics } from './application/application-metrics.ts';
import { ApplicationTraces } from './application/application-traces.ts';
import { CompanyLatestMetrics } from './application/company-latest-metrics.ts';
import { LATEST_METRICS } from '@dreamdevops/contracts/monitoring/services';
import {
  LOG_STORE,
  type LogStore,
  METRICS_STORE,
  type MetricsStore,
  TELEMETRY_SINK,
  type TelemetrySink,
  TRACE_STORE,
  type TraceStore,
} from './application/ports.ts';
import { RunningPlaces } from './application/running-places.ts';
import { TelemetryGateway } from './application/telemetry-gateway.ts';
import { MonitoringController } from './http/monitoring.controller.ts';
import { TelemetryController } from './http/telemetry.controller.ts';
import { CollectorTelemetrySink } from './infrastructure/collector-telemetry-sink.ts';
import { JaegerTraceStore } from './infrastructure/jaeger-trace-store.ts';
import { LokiLogStore } from './infrastructure/loki-log-store.ts';
import { PrometheusMetricsStore } from './infrastructure/prometheus-metrics-store.ts';

/**
 * The metrics, logs and traces of what runs in each company's environments. Targets'
 * collectors send them through the telemetry gateway, which labels them with where they
 * come from; applications on This machine send them to the platform's collector. They're
 * kept in Prometheus, Jaeger and Loki, and read back here, by place.
 */
@Module({})
export class MonitoringModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, MonitoringModule, () => {
      const { config } = settings;
      return {
        module: MonitoringModule,
        imports: [CatalogModule.register(settings), EnvironmentsModule.register(settings), DeploymentsModule.register(settings)],
        controllers: [MonitoringController, TelemetryController],
        providers: withOverrides(
          [
            // Without a store, the dashboard says it isn't set up, and everything else works.
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
              provide: LOG_STORE,
              useFactory: (): LogStore | null => (config.lokiUrl === null ? null : new LokiLogStore({ url: config.lokiUrl })),
            },
            {
              provide: TELEMETRY_SINK,
              useFactory: (): TelemetrySink | null =>
                config.telemetryCollectorUrl === null ? null : new CollectorTelemetrySink({ url: config.telemetryCollectorUrl }),
            },
            {
              provide: RunningPlaces,
              useFactory: (deployments: RunningVersions) => new RunningPlaces(deployments),
              inject: [RUNNING_VERSIONS],
            },
            {
              provide: TelemetryGateway,
              useFactory: (agents: TargetAuthentication, catalog: ApplicationDirectory, sink: TelemetrySink | null) =>
                new TelemetryGateway(agents, catalog, sink),
              inject: [TARGET_AUTHENTICATION, APPLICATION_DIRECTORY, TELEMETRY_SINK],
            },
            {
              provide: ApplicationLogs,
              useFactory: (places: RunningPlaces, deployments: RunningVersions, store: LogStore | null) =>
                new ApplicationLogs(places, deployments, store),
              inject: [RunningPlaces, RUNNING_VERSIONS, LOG_STORE],
            },
            {
              provide: ApplicationTraces,
              useFactory: (places: RunningPlaces, store: TraceStore | null) => new ApplicationTraces(places, store),
              inject: [RunningPlaces, TRACE_STORE],
            },
            {
              provide: ApplicationMetrics,
              useFactory: (places: RunningPlaces, store: MetricsStore | null) => new ApplicationMetrics(places, store),
              inject: [RunningPlaces, METRICS_STORE],
            },
            {
              provide: LATEST_METRICS,
              useFactory: (places: RunningPlaces, store: MetricsStore | null) => new CompanyLatestMetrics(places, store),
              inject: [RunningPlaces, METRICS_STORE],
            },
          ],
          settings.overrides,
        ),
        // Other contexts, such as Alerts, see only the latest metrics of their company's places, and what runs.
        exports: [LATEST_METRICS, RunningPlaces],
      };
    });
  }
}
