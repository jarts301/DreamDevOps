import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Req } from '@nestjs/common';
import { Public } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { type TargetConfiguration, TargetConfigurations } from '../../environments/application/target-configuration.ts';
import { type AgentCommand, Deployments } from '../application/deployments.ts';
import { type Registration, TargetAgents } from '../../environments/application/target-agents.ts';

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
  readonly #configurations: TargetConfigurations;
  readonly #deployments: Deployments;

  constructor(
    @Inject(TargetAgents) agents: TargetAgents,
    @Inject(TargetConfigurations) configurations: TargetConfigurations,
    @Inject(Deployments) deployments: Deployments,
  ) {
    this.#agents = agents;
    this.#configurations = configurations;
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
    const { companyId, environmentId } = await this.#agents.authenticate(bearer(request));
    await this.#deployments.commandDone(companyId, environmentId, id, body ?? {});
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

  /** Reports in, with how the environment's rollouts are doing; gets back commands to run. */
  @Post('heartbeat')
  @HttpCode(200)
  async heartbeat(
    @Req() request: ApiRequest,
    @Body() body: { agentVersion?: unknown; kubernetesVersion?: unknown; sync?: unknown; workloads?: unknown },
  ): Promise<{ heartbeatSeconds: number; commands: AgentCommand[] }> {
    const token = bearer(request);
    const { heartbeatSeconds } = await this.#agents.heartbeat(token, body ?? {});
    const { companyId, environmentId } = await this.#agents.authenticate(token);
    return { heartbeatSeconds, commands: await this.#deployments.onReport(companyId, environmentId, body ?? {}) };
  }
}
