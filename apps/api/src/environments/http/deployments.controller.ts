import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { Authenticated } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { Deployments } from '../application/deployments.ts';

type Body = Record<string, unknown> | undefined;

/**
 * Every member can follow deployments. Who may deploy depends on the environment:
 * deployments-test:run for the others, deployments-production:run for production, so
 * the service checks the permission.
 */
@Controller('company')
export class DeploymentsController {
  readonly #deployments: Deployments;

  constructor(@Inject(Deployments) deployments: Deployments) {
    this.#deployments = deployments;
  }

  /** The application's versions, and whether each may run in this environment. */
  @Authenticated()
  @Get('environments/:id/versions')
  options(@Param('id') id: string): Promise<object[]> {
    return this.#deployments.options(id);
  }

  @Authenticated()
  @Get('environments/:id/deployments')
  list(@Param('id') id: string): Promise<object[]> {
    return this.#deployments.list(id);
  }

  @Authenticated()
  @Post('environments/:id/deployments')
  @HttpCode(202)
  deploy(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Body): Promise<object> {
    return this.#deployments.deploy(request.principal!, id, body ?? {});
  }

  @Authenticated()
  @Post('environments/:id/stop')
  @HttpCode(202)
  stop(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Body): Promise<object> {
    return this.#deployments.stop(request.principal!, id, body ?? {});
  }

  @Authenticated()
  @Get('deployments/:deploymentId')
  get(@Param('deploymentId') deploymentId: string): Promise<object> {
    return this.#deployments.get(deploymentId);
  }
}
