import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Authenticated, RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { EnvironmentConfig, type EnvironmentConfigView } from '../application/environment-config.ts';
import { type Connection, Environments, type EnvironmentView } from '../application/environments.ts';

/** Creating environments and connecting their targets use this permission, which Company Admins and Operators have. */
const MANAGE_TARGETS = 'targets:connect';

/** Every member can see the company's environments and their health. */
@Controller('company/environments')
export class EnvironmentsController {
  readonly #environments: Environments;
  readonly #config: EnvironmentConfig;

  constructor(@Inject(Environments) environments: Environments, @Inject(EnvironmentConfig) config: EnvironmentConfig) {
    this.#environments = environments;
    this.#config = config;
  }

  /** Variables with their values, and secrets by name only. With ?application=, that application's too. */
  @Authenticated()
  @Get(':id/config')
  config(@Param('id') id: string, @Query('application') application: unknown): Promise<EnvironmentConfigView> {
    return this.#config.view(id, application);
  }

  // Who may change values depends on the environment's kind, so the service checks it.
  @Authenticated()
  @Put(':id/variables/:name')
  @HttpCode(204)
  setVariable(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Param('name') name: string,
    @Body() body: { value?: unknown; application?: unknown },
  ): Promise<void> {
    return this.#config.setVariable(request.principal!, id, name, body ?? {});
  }

  @Authenticated()
  @Delete(':id/variables/:name')
  @HttpCode(204)
  removeVariable(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Param('name') name: string,
    @Query('application') application: unknown,
  ): Promise<void> {
    return this.#config.removeVariable(request.principal!, id, name, application);
  }

  @Authenticated()
  @Put(':id/secrets/:name')
  @HttpCode(204)
  setSecret(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Param('name') name: string,
    @Body() body: { value?: unknown; application?: unknown },
  ): Promise<void> {
    return this.#config.setSecret(request.principal!, id, name, body ?? {});
  }

  @Authenticated()
  @Delete(':id/secrets/:name')
  @HttpCode(204)
  removeSecret(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Param('name') name: string,
    @Query('application') application: unknown,
  ): Promise<void> {
    return this.#config.removeSecret(request.principal!, id, name, application);
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
    @Body() body: { name?: unknown; acceptsFeatureImages?: unknown; requiresApproval?: unknown },
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
