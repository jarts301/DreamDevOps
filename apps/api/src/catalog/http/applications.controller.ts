import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Authenticated, RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { ApplicationCatalog } from '../application/application-catalog.ts';

/** Registering, editing and archiving all use this permission, which Tech Leads and Company Admins have. */
const MANAGE_APPLICATIONS = 'applications:create';

/** Every member can see the company's applications. Users without a company are refused. */
@Controller('company')
export class ApplicationsController {
  readonly #catalog: ApplicationCatalog;

  constructor(@Inject(ApplicationCatalog) catalog: ApplicationCatalog) {
    this.#catalog = catalog;
  }

  @Authenticated()
  @Get('application-types')
  types(): Promise<object[]> {
    return this.#catalog.types();
  }

  @Authenticated()
  @Get('applications')
  list(@Query('status') status: unknown): Promise<object[]> {
    return this.#catalog.list(status);
  }

  @Authenticated()
  @Get('applications/:id')
  get(@Param('id') id: string): Promise<object> {
    return this.#catalog.get(id);
  }

  @RequirePermissions(MANAGE_APPLICATIONS)
  @Post('applications')
  register(
    @Req() request: ApiRequest,
    @Body() body: { name?: unknown; type?: unknown; description?: unknown },
  ): Promise<object> {
    return this.#catalog.register(request.principal!, body ?? {});
  }

  @RequirePermissions(MANAGE_APPLICATIONS)
  @Patch('applications/:id')
  @HttpCode(204)
  update(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Body() body: { name?: unknown; description?: unknown },
  ): Promise<void> {
    return this.#catalog.update(request.principal!, id, body ?? {});
  }

  @RequirePermissions(MANAGE_APPLICATIONS)
  @Post('applications/:id/archive')
  @HttpCode(204)
  archive(@Req() request: ApiRequest, @Param('id') id: string): Promise<void> {
    return this.#catalog.archive(request.principal!, id);
  }

  @RequirePermissions(MANAGE_APPLICATIONS)
  @Post('applications/:id/restore')
  @HttpCode(204)
  restore(@Req() request: ApiRequest, @Param('id') id: string): Promise<void> {
    return this.#catalog.restore(request.principal!, id);
  }
}
