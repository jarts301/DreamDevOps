import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { HeartbeatResponse } from '@dreamdevops/contracts/agent/protocol';
import { Public } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { Deployments } from '../application/deployments.ts';

const bearer = (request: ApiRequest): string | undefined =>
  /^Bearer (\S{1,200})$/.exec(request.headers.authorization ?? '')?.[1];

/**
 * Where the agent in each target reports how its environment's rollouts are doing, and
 * gets back the promote and abort commands waiting for it. It proves itself with the
 * access token Environments gave it. Agents call these every heartbeat, so they have only
 * the general rate limit: many targets behind one address would otherwise use up the
 * stricter sign-in one and be marked as lost.
 */
@Controller('agent')
@Public()
export class AgentController {
  readonly #deployments: Deployments;

  constructor(@Inject(Deployments) deployments: Deployments) {
    this.#deployments = deployments;
  }

  /** The agent says how a promote or abort command went. */
  @Post('commands/:id')
  @HttpCode(204)
  commandDone(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: { succeeded?: unknown; message?: unknown } | undefined): Promise<void> {
    return this.#deployments.agentCommandDone(bearer(request), id, body ?? {});
  }

  /** Reports in, with how the environment's rollouts are doing; gets back commands to run. */
  @Post('heartbeat')
  @HttpCode(200)
  heartbeat(
    @Req() request: ApiRequest,
    @Body() body: { agentVersion?: unknown; kubernetesVersion?: unknown; sync?: unknown; workloads?: unknown } | undefined,
  ): Promise<HeartbeatResponse> {
    return this.#deployments.agentHeartbeat(bearer(request), body ?? {});
  }
}
