import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { ChangeRunning, DeploymentView, RequestDeployment, RunningVersion } from '@dreamdevops/contracts/deployments/http';
import type { Unchecked } from '@dreamdevops/contracts/http';
import { Authenticated } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { type Confirmed, Deployments } from '../application/deployments.ts';

/**
 * Every member can follow deployments. Who may deploy, approve, promote or abort depends
 * on the environment's kind, so the service checks the permission each time.
 */
@Controller('company')
export class DeploymentsController {
  readonly #deployments: Deployments;

  constructor(@Inject(Deployments) deployments: Deployments) {
    this.#deployments = deployments;
  }

  @Authenticated()
  @Get('deployments')
  list(@Query('application') application: unknown, @Query('environment') environment: unknown): Promise<DeploymentView[]> {
    return this.#deployments.list({ application, environment });
  }

  @Authenticated()
  @Get('deployments/:id')
  get(@Param('id') id: string): Promise<DeploymentView> {
    return this.#deployments.get(id);
  }

  @Authenticated()
  @Post('applications/:id/deployments')
  request(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Body() body: Unchecked<RequestDeployment> | undefined,
  ): Promise<DeploymentView> {
    return this.#deployments.request(request.principal!, id, body ?? {});
  }

  /** What runs now, by ?application= or ?environment=, with whether the environment's values changed since. */
  @Authenticated()
  @Get('running')
  running(@Query('application') application: unknown, @Query('environment') environment: unknown): Promise<RunningVersion[]> {
    return this.#deployments.running({ application, environment });
  }

  /** Removes what runs of the application in { environment }. Production also needs its name and a reason. */
  @Authenticated()
  @Post('applications/:id/stop')
  stop(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Unchecked<ChangeRunning> | undefined): Promise<DeploymentView> {
    return this.#deployments.stop(request.principal!, id, body ?? {});
  }

  /** Runs what runs in { environment } again, with the environment's values as they are now. */
  @Authenticated()
  @Post('applications/:id/apply')
  apply(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Unchecked<ChangeRunning> | undefined): Promise<DeploymentView> {
    return this.#deployments.apply(request.principal!, id, body ?? {});
  }

  @Authenticated()
  @Post('deployments/:id/approve')
  @HttpCode(204)
  approve(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Confirmed | undefined): Promise<void> {
    return this.#deployments.approve(request.principal!, id, body ?? {});
  }

  @Authenticated()
  @Post('deployments/:id/reject')
  @HttpCode(204)
  reject(@Req() request: ApiRequest, @Param('id') id: string): Promise<void> {
    return this.#deployments.reject(request.principal!, id);
  }

  @Authenticated()
  @Post('deployments/:id/promote')
  @HttpCode(204)
  promote(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Confirmed | undefined): Promise<void> {
    return this.#deployments.promote(request.principal!, id, body ?? {});
  }

  @Authenticated()
  @Post('deployments/:id/abort')
  @HttpCode(204)
  abort(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Confirmed | undefined): Promise<void> {
    return this.#deployments.abort(request.principal!, id, body ?? {});
  }

  @Authenticated()
  @Post('deployments/:id/rollback')
  rollback(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Confirmed | undefined): Promise<DeploymentView> {
    return this.#deployments.rollback(request.principal!, id, body ?? {});
  }
}
