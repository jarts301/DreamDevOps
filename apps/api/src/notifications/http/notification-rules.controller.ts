import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
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
  eventTypes(): object[] {
    return this.#rules.eventTypes();
  }

  @Get()
  list(): Promise<object[]> {
    return this.#rules.list();
  }

  @Post()
  create(@Req() request: ApiRequest, @Body() body: Record<string, unknown> | undefined): Promise<object> {
    return this.#rules.create(request.principal!, body ?? {});
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown> | undefined): Promise<object> {
    return this.#rules.update(id, body ?? {});
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@Param('id') id: string): Promise<void> {
    return this.#rules.delete(id);
  }

  @Post(':id/test')
  @HttpCode(200)
  test(@Req() request: ApiRequest, @Param('id') id: string): Promise<object> {
    return this.#rules.test(request.principal!, id);
  }
}
