import { Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { Authenticated, RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { Repositories } from '../application/repositories.ts';
import { SourceAccess } from '../application/source-access.ts';

/** Every member can see repositories and their own Git access. Users without a company are refused. */
@Controller('company')
export class SourceController {
  readonly #repositories: Repositories;
  readonly #access: SourceAccess;

  constructor(@Inject(Repositories) repositories: Repositories, @Inject(SourceAccess) access: SourceAccess) {
    this.#repositories = repositories;
    this.#access = access;
  }

  @Authenticated()
  @Get('repositories')
  list(): Promise<object[]> {
    return this.#repositories.list();
  }

  /** Creates the repository of an application registered before repositories existed, or retries a failure. */
  @RequirePermissions('applications:create')
  @Post('applications/:id/repository')
  @HttpCode(202)
  request(@Req() request: ApiRequest, @Param('id') id: string): Promise<void> {
    return this.#repositories.request(request.principal!, id);
  }

  @Authenticated()
  @Get('source-access')
  mine(@Req() request: ApiRequest): Promise<object> {
    return this.#access.mine(request.principal!);
  }

  /** Checks for new Git accounts, such as right after someone first signs in to Forgejo. */
  @Authenticated()
  @Post('source-access/sync')
  async sync(@Req() request: ApiRequest): Promise<object> {
    await this.#access.syncCompany();
    return this.#access.mine(request.principal!);
  }
}
