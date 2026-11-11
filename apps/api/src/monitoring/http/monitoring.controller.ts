import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { RequireFeature } from '../../editions/http/feature.guard.ts';
import { RequirePermissions } from '../../http/access.decorators.ts';
import { ApplicationMetrics } from '../application/application-metrics.ts';

/** Every company role views dashboards: Company Admins, Tech Leads, Developers, Operators and Viewers. */
const VIEW_DASHBOARDS = 'dashboards:view';

/** Metrics of what runs in the company's environments. Nothing here changes anything. */
@Controller('company/monitoring')
export class MonitoringController {
  readonly #metrics: ApplicationMetrics;

  constructor(@Inject(ApplicationMetrics) metrics: ApplicationMetrics) {
    this.#metrics = metrics;
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
}
