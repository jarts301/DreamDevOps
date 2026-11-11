import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { RequireFeature } from '../../editions/http/feature.guard.ts';
import { RequirePermissions } from '../../http/access.decorators.ts';
import { ApplicationLogs } from '../application/application-logs.ts';
import { ApplicationMetrics } from '../application/application-metrics.ts';
import { ApplicationTraces } from '../application/application-traces.ts';

/** Every company role views dashboards and logs: Company Admins, Tech Leads, Developers, Operators and Viewers. */
const VIEW_DASHBOARDS = 'dashboards:view';

/** Metrics, logs and traces of what runs in the company's environments. Nothing here changes anything. */
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
  @Get('environments')
  overview(): Promise<object> {
    return this.#metrics.overview();
  }

  @RequirePermissions(VIEW_DASHBOARDS)
  @RequireFeature('monitoring')
  @Get('environments/:id')
  environment(@Param('id') id: string, @Query('range') range: unknown): Promise<object> {
    return this.#metrics.environment(id, range);
  }

  @RequirePermissions(VIEW_DASHBOARDS)
  @RequireFeature('monitoring')
  @Get('environments/:id/logs')
  logs(@Param('id') id: string, @Query('range') range: unknown): Promise<object> {
    return this.#logs.read(id, range);
  }

  @RequirePermissions(VIEW_DASHBOARDS)
  @RequireFeature('monitoring')
  @Get('environments/:id/traces')
  traces(@Param('id') id: string, @Query('range') range: unknown): Promise<object> {
    return this.#traces.recent(id, range);
  }

  @RequirePermissions(VIEW_DASHBOARDS)
  @RequireFeature('monitoring')
  @Get('traces/:traceId')
  trace(@Param('traceId') traceId: string): Promise<object> {
    return this.#traces.trace(traceId);
  }
}
