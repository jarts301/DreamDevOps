import { Body, Controller, Get, HttpCode, Inject, Post, Put, Req } from '@nestjs/common';
import type { TargetConfiguration } from '@dreamdevops/contracts/agent/protocol';
import { Public, SignInRateLimit } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { type Registration, TargetAgents } from '../application/target-agents.ts';
import { TargetConfigurations } from '../application/target-configuration.ts';

const bearer = (request: ApiRequest): string | undefined =>
  /^Bearer (\S{1,200})$/.exec(request.headers.authorization ?? '')?.[1];

/**
 * Where the agent in each target proves itself and learns what it needs. It has no
 * session and only makes outbound calls, so each route checks its own proof: a
 * registration token, a signed assertion or an access token. Deployments takes its
 * heartbeats, on the same path.
 */
@Controller('agent')
@Public()
export class EnvironmentAgentController {
  readonly #agents: TargetAgents;
  readonly #configurations: TargetConfigurations;

  constructor(@Inject(TargetAgents) agents: TargetAgents, @Inject(TargetConfigurations) configurations: TargetConfigurations) {
    this.#agents = agents;
    this.#configurations = configurations;
  }

  /** Registers the agent's public key with the one-time token from the dashboard. */
  @SignInRateLimit()
  @Post('register')
  @HttpCode(201)
  register(
    @Body()
    body: { registrationToken?: unknown; publicKey?: unknown; agentVersion?: unknown; kubernetesVersion?: unknown },
  ): Promise<Registration> {
    return this.#agents.register(body ?? {});
  }

  /** Swaps an assertion signed with the agent's key for a short-lived access token. */
  @SignInRateLimit()
  @Post('token')
  @HttpCode(200)
  token(@Body() body: { assertion?: unknown }): Promise<{ accessToken: string; expiresIn: number }> {
    return this.#agents.issueAccessToken(body?.assertion);
  }

  /** Registers the read-only SSH key Flux uses for the environment repository. */
  @Put('deploy-key')
  @HttpCode(204)
  deployKey(@Req() request: ApiRequest, @Body() body: { publicKey?: unknown }): Promise<void> {
    return this.#configurations.setDeployKey(bearer(request), body ?? {});
  }

  /** What the target needs to run its environment. */
  @Get('configuration')
  configuration(@Req() request: ApiRequest): Promise<TargetConfiguration> {
    return this.#configurations.configuration(bearer(request));
  }
}
