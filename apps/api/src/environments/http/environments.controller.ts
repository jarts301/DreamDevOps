import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Authenticated, RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { Environments } from '../application/environments.ts';
import { MANAGE_PRODUCTION } from '../application/hosting-targets.ts';

/** Company Admins, Tech Leads and Operators manage environments. */
const MANAGE_ENVIRONMENTS = 'environments:manage';

type Body = Record<string, unknown> | undefined;

/**
 * Every member can see environments. Anything that touches production also needs the
 * permission to manage production, which the service checks, with the environment's
 * name typed and a reason.
 */
@Controller('company')
export class EnvironmentsController {
  readonly #environments: Environments;

  constructor(@Inject(Environments) environments: Environments) {
    this.#environments = environments;
  }

  @Authenticated()
  @Get('applications/:id/environments')
  list(@Param('id') id: string, @Query('status') status: unknown): Promise<object[]> {
    return this.#environments.list(id, status);
  }

  @RequirePermissions(MANAGE_ENVIRONMENTS)
  @Post('applications/:id/environments')
  create(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Body): Promise<object> {
    return this.#environments.create(request.principal!, id, body ?? {});
  }

  @RequirePermissions(MANAGE_ENVIRONMENTS)
  @Patch('environments/:id')
  update(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Body): Promise<object> {
    return this.#environments.update(request.principal!, id, body ?? {});
  }

  @RequirePermissions(MANAGE_ENVIRONMENTS, MANAGE_PRODUCTION)
  @Post('environments/:id/protect')
  @HttpCode(200)
  protect(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Body): Promise<object> {
    return this.#environments.protect(request.principal!, id, body ?? {});
  }

  @RequirePermissions(MANAGE_ENVIRONMENTS, MANAGE_PRODUCTION)
  @Post('environments/:id/unprotect')
  @HttpCode(200)
  unprotect(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Body): Promise<object> {
    return this.#environments.unprotect(request.principal!, id, body ?? {});
  }

  @RequirePermissions(MANAGE_ENVIRONMENTS)
  @Post('environments/:id/archive')
  @HttpCode(200)
  archive(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Body): Promise<object> {
    return this.#environments.archive(request.principal!, id, body ?? {});
  }

  @RequirePermissions(MANAGE_ENVIRONMENTS)
  @Post('environments/:id/restore')
  @HttpCode(200)
  restore(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Body): Promise<object> {
    return this.#environments.restore(request.principal!, id, body ?? {});
  }
}
