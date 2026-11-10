import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Authenticated, RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { HostingTargets } from '../application/hosting-targets.ts';

/** Company Admins and Operators connect hosting targets. */
const CONNECT_TARGETS = 'targets:connect';

type Body = Record<string, unknown> | undefined;

/** Every member can see where environments can run. Users without a company are refused. */
@Controller('company')
export class HostingTargetsController {
  readonly #targets: HostingTargets;

  constructor(@Inject(HostingTargets) targets: HostingTargets) {
    this.#targets = targets;
  }

  @Authenticated()
  @Get('hosting-providers')
  providers(): readonly object[] {
    return this.#targets.providers();
  }

  @Authenticated()
  @Get('hosting-targets')
  list(@Query('status') status: unknown): Promise<object[]> {
    return this.#targets.list(status);
  }

  @RequirePermissions(CONNECT_TARGETS)
  @Post('hosting-targets')
  connect(@Req() request: ApiRequest, @Body() body: Body): Promise<object> {
    return this.#targets.connect(request.principal!, body ?? {});
  }

  /** A target production runs on also needs the permission to manage production, which the service checks. */
  @RequirePermissions(CONNECT_TARGETS)
  @Patch('hosting-targets/:id')
  update(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Body): Promise<object> {
    return this.#targets.update(request.principal!, id, body ?? {});
  }

  @RequirePermissions(CONNECT_TARGETS)
  @Post('hosting-targets/:id/archive')
  @HttpCode(200)
  archive(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Body): Promise<object> {
    return this.#targets.archive(request.principal!, id, body ?? {});
  }

  @RequirePermissions(CONNECT_TARGETS)
  @Post('hosting-targets/:id/restore')
  @HttpCode(200)
  restore(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Body): Promise<object> {
    return this.#targets.restore(request.principal!, id, body ?? {});
  }
}
