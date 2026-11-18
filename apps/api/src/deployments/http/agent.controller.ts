import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { AgentCommand, HeartbeatResponse } from '@dreamdevops/contracts/agent/protocol';
import { TARGET_AUTHENTICATION, type TargetAuthentication } from '@dreamdevops/contracts/environments/services';
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
  readonly #targets: TargetAuthentication;
  readonly #deployments: Deployments;

  constructor(@Inject(TARGET_AUTHENTICATION) targets: TargetAuthentication, @Inject(Deployments) deployments: Deployments) {
    this.#targets = targets;
    this.#deployments = deployments;
  }

  /** The agent says how a promote or abort command went. */
  @Post('commands/:id')
  @HttpCode(204)
  async commandDone(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Body() body: { succeeded?: unknown; message?: unknown },
  ): Promise<void> {
    const { companyId, environmentId } = await this.#targets.authenticate(bearer(request));
    await this.#deployments.commandDone(companyId, environmentId, id, body ?? {});
  }

  /** Reports in, with how the environment's rollouts are doing; gets back commands to run. */
  @Post('heartbeat')
  @HttpCode(200)
  async heartbeat(
    @Req() request: ApiRequest,
    @Body() body: { agentVersion?: unknown; kubernetesVersion?: unknown; sync?: unknown; workloads?: unknown },
  ): Promise<HeartbeatResponse> {
    // The heartbeat checks the access token, and says whose target it is.
    const { heartbeatSeconds, companyId, environmentId } = await this.#targets.heartbeat(bearer(request), body ?? {});
    const commands: AgentCommand[] = await this.#deployments.onReport(companyId, environmentId, body ?? {});
    return { heartbeatSeconds, commands };
  }
}
