import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { Public } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { type Registration, TargetAgents } from '../application/target-agents.ts';

const bearer = (request: ApiRequest): string | undefined =>
  /^Bearer (\S{1,200})$/.exec(request.headers.authorization ?? '')?.[1];

/**
 * Called by the agent in each target, which has no session and only makes outbound
 * calls. Each route checks its own proof: a registration token, a signed assertion or an
 * access token. These routes share the stricter sign-in rate limit.
 */
@Controller('agent')
@Public()
export class AgentController {
  readonly #agents: TargetAgents;

  constructor(@Inject(TargetAgents) agents: TargetAgents) {
    this.#agents = agents;
  }

  /** Registers the agent's public key with the one-time token from the dashboard. */
  @Post('register')
  @HttpCode(201)
  register(
    @Body()
    body: { registrationToken?: unknown; publicKey?: unknown; agentVersion?: unknown; kubernetesVersion?: unknown },
  ): Promise<Registration> {
    return this.#agents.register(body ?? {});
  }

  /** Swaps an assertion signed with the agent's key for a short-lived access token. */
  @Post('token')
  @HttpCode(200)
  token(@Body() body: { assertion?: unknown }): Promise<{ accessToken: string; expiresIn: number }> {
    return this.#agents.issueAccessToken(body?.assertion);
  }

  @Post('heartbeat')
  @HttpCode(200)
  heartbeat(
    @Req() request: ApiRequest,
    @Body() body: { agentVersion?: unknown; kubernetesVersion?: unknown },
  ): Promise<{ heartbeatSeconds: number }> {
    return this.#agents.heartbeat(bearer(request), body ?? {});
  }
}
