import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { RequireFeature } from '../../editions/http/feature.guard.ts';
import { RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { hasPermissions } from '../../identity-access/domain/access.ts';
import { AlertRules } from '../application/alert-rules.ts';

/** Every company role views dashboards, and so sees alerts and their history. */
const VIEW_DASHBOARDS = 'dashboards:view';
/** Company Admins, Tech Leads and Operators manage alerts, as they manage environments. */
const MANAGE_ALERTS = 'alerts:manage';

type Body = Record<string, unknown> | undefined;

/** The company's alerts on its environments' metrics, which the monitoring feature includes. */
@Controller('company/alerts')
export class AlertsController {
  readonly #rules: AlertRules;

  constructor(@Inject(AlertRules) rules: AlertRules) {
    this.#rules = rules;
  }

  /** Whom alerts email is shown only to those who manage them. */
  @RequirePermissions(VIEW_DASHBOARDS)
  @RequireFeature('monitoring')
  @Get()
  list(@Req() request: ApiRequest): Promise<object> {
    return this.#rules.list({ showRecipients: hasPermissions(request.principal!, [MANAGE_ALERTS]) });
  }

  @RequirePermissions(VIEW_DASHBOARDS)
  @RequireFeature('monitoring')
  @Get('incidents')
  history(): Promise<object[]> {
    return this.#rules.history();
  }

  @RequirePermissions(MANAGE_ALERTS)
  @RequireFeature('monitoring')
  @Post()
  create(@Req() request: ApiRequest, @Body() body: Body): Promise<object> {
    return this.#rules.create(request.principal!, body ?? {});
  }

  @RequirePermissions(MANAGE_ALERTS)
  @RequireFeature('monitoring')
  @Patch(':id')
  update(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Body): Promise<object> {
    return this.#rules.update(request.principal!, id, body ?? {});
  }

  @RequirePermissions(MANAGE_ALERTS)
  @RequireFeature('monitoring')
  @Delete(':id')
  @HttpCode(204)
  delete(@Req() request: ApiRequest, @Param('id') id: string): Promise<void> {
    return this.#rules.delete(request.principal!, id);
  }

  @RequirePermissions(MANAGE_ALERTS)
  @RequireFeature('monitoring')
  @Post(':id/test')
  @HttpCode(200)
  test(@Req() request: ApiRequest, @Param('id') id: string): Promise<object> {
    return this.#rules.test(request.principal!, id);
  }
}
