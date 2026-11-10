import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Authenticated, RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { type Connection, Environments, type EnvironmentView } from '../application/environments.ts';

/** Creating environments and connecting their targets use this permission, which Company Admins and Operators have. */
const MANAGE_TARGETS = 'targets:connect';

/** Every member can see the company's environments and their health. */
@Controller('company/environments')
export class EnvironmentsController {
  readonly #environments: Environments;

  constructor(@Inject(Environments) environments: Environments) {
    this.#environments = environments;
  }

  @Authenticated()
  @Get()
  list(@Query('status') status: unknown): Promise<EnvironmentView[]> {
    return this.#environments.list(status);
  }

  @Authenticated()
  @Get(':id')
  get(@Param('id') id: string): Promise<EnvironmentView> {
    return this.#environments.get(id);
  }

  @RequirePermissions(MANAGE_TARGETS)
  @Post()
  create(
    @Req() request: ApiRequest,
    @Body() body: { name?: unknown; kind?: unknown; acceptsFeatureImages?: unknown },
  ): Promise<EnvironmentView> {
    return this.#environments.create(request.principal!, body ?? {});
  }

  @RequirePermissions(MANAGE_TARGETS)
  @Patch(':id')
  @HttpCode(204)
  update(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Body() body: { name?: unknown; acceptsFeatureImages?: unknown },
  ): Promise<void> {
    return this.#environments.update(request.principal!, id, body ?? {});
  }

  @RequirePermissions(MANAGE_TARGETS)
  @Post(':id/archive')
  @HttpCode(204)
  archive(@Req() request: ApiRequest, @Param('id') id: string): Promise<void> {
    return this.#environments.archive(request.principal!, id);
  }

  @RequirePermissions(MANAGE_TARGETS)
  @Post(':id/restore')
  @HttpCode(204)
  restore(@Req() request: ApiRequest, @Param('id') id: string): Promise<void> {
    return this.#environments.restore(request.principal!, id);
  }

  /** Returns a one-time registration token and the command that uses it. */
  @RequirePermissions(MANAGE_TARGETS)
  @Post(':id/target')
  connect(@Req() request: ApiRequest, @Param('id') id: string): Promise<Connection> {
    return this.#environments.connect(request.principal!, id);
  }

  @RequirePermissions(MANAGE_TARGETS)
  @Delete(':id/target')
  @HttpCode(204)
  disconnect(@Req() request: ApiRequest, @Param('id') id: string): Promise<void> {
    return this.#environments.disconnect(request.principal!, id);
  }
}
