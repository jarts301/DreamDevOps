import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { Unchecked } from '@dreamdevops/contracts/http';
import type {
  CreateRule,
  NotifiableEventType,
  RuleTestResult,
  RuleView,
  UpdateRule,
} from '@dreamdevops/contracts/notifications/http';
import { RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { NotificationRules } from '../application/notification-rules.ts';

@Controller('company/notification-rules')
@RequirePermissions('notifications:manage')
export class NotificationRulesController {
  readonly #rules: NotificationRules;

  constructor(@Inject(NotificationRules) rules: NotificationRules) {
    this.#rules = rules;
  }

  @Get('event-types')
  eventTypes(): NotifiableEventType[] {
    return this.#rules.eventTypes();
  }

  @Get()
  list(): Promise<RuleView[]> {
    return this.#rules.list();
  }

  @Post()
  create(@Req() request: ApiRequest, @Body() body: Unchecked<CreateRule> | undefined): Promise<RuleView> {
    return this.#rules.create(request.principal!, body ?? {});
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Unchecked<UpdateRule> | undefined): Promise<RuleView> {
    return this.#rules.update(id, body ?? {});
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@Param('id') id: string): Promise<void> {
    return this.#rules.delete(id);
  }

  @Post(':id/test')
  @HttpCode(200)
  test(@Req() request: ApiRequest, @Param('id') id: string): Promise<RuleTestResult> {
    return this.#rules.test(request.principal!, id);
  }
}
