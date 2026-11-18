import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type {
  EnvironmentLogView,
  EnvironmentMetrics,
  EnvironmentTraces,
  MonitoringOverview,
  TraceView,
} from '@dreamdevops/contracts/monitoring/http';
import { RequireFeature, RequirePermissions } from '../../http/access.decorators.ts';
import { ApplicationLogs } from '../application/application-logs.ts';
import { ApplicationMetrics } from '../application/application-metrics.ts';
import { ApplicationTraces } from '../application/application-traces.ts';

/** Every company role views dashboards and logs: Company Admins, Tech Leads, Developers, Operators and Viewers. */
const VIEW_DASHBOARDS = 'dashboards:view';

/**
 * Metrics, logs and traces of what runs in the company's environments, by place: one
 * application in one environment. Nothing here changes anything.
 */
@Controller('company/monitoring')
export class MonitoringController {
  readonly #metrics: ApplicationMetrics;
  readonly #logs: ApplicationLogs;
  readonly #traces: ApplicationTraces;

  constructor(
    @Inject(ApplicationMetrics) metrics: ApplicationMetrics,
    @Inject(ApplicationLogs) logs: ApplicationLogs,
    @Inject(ApplicationTraces) traces: ApplicationTraces,
  ) {
    this.#metrics = metrics;
    this.#logs = logs;
    this.#traces = traces;
  }

  @RequirePermissions(VIEW_DASHBOARDS)
  @RequireFeature('monitoring')
  @Get('places')
  overview(): Promise<MonitoringOverview> {
    return this.#metrics.overview();
  }

  @RequirePermissions(VIEW_DASHBOARDS)
  @RequireFeature('monitoring')
  @Get('places/:id')
  environment(@Param('id') id: string, @Query('range') range: unknown): Promise<EnvironmentMetrics> {
    return this.#metrics.environment(id, range);
  }

  @RequirePermissions(VIEW_DASHBOARDS)
  @RequireFeature('monitoring')
  @Get('places/:id/logs')
  logs(@Param('id') id: string, @Query('range') range: unknown): Promise<EnvironmentLogView> {
    return this.#logs.read(id, range);
  }

  @RequirePermissions(VIEW_DASHBOARDS)
  @RequireFeature('monitoring')
  @Get('places/:id/traces')
  traces(@Param('id') id: string, @Query('range') range: unknown): Promise<EnvironmentTraces> {
    return this.#traces.recent(id, range);
  }

  @RequirePermissions(VIEW_DASHBOARDS)
  @RequireFeature('monitoring')
  @Get('traces/:traceId')
  trace(@Param('traceId') traceId: string): Promise<TraceView> {
    return this.#traces.trace(traceId);
  }
}
