import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { Authenticated, RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { Releases } from '../application/releases.ts';

/** Every member can follow releases. Starting them needs releases:start, which Tech Leads have. */
@Controller('company')
export class ReleasesController {
  readonly #releases: Releases;

  constructor(@Inject(Releases) releases: Releases) {
    this.#releases = releases;
  }

  @Authenticated()
  @Get('applications/:id/releases')
  list(@Param('id') id: string): Promise<object> {
    return this.#releases.list(id);
  }

  @RequirePermissions('releases:start')
  @Post('applications/:id/releases')
  async start(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Body() body: { kind?: unknown; version?: unknown },
  ): Promise<object> {
    return { id: await this.#releases.start(request.principal!, id, body ?? {}) };
  }

  @RequirePermissions('releases:start')
  @Post('releases/:id/final-build')
  @HttpCode(202)
  rebuild(@Param('id') id: string): Promise<void> {
    return this.#releases.rebuildFinal(id);
  }
}
