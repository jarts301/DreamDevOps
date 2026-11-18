import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { TelemetryGateway } from '../application/telemetry-gateway.ts';

const bearer = (request: ApiRequest): string | undefined => {
  const match = /^Bearer (\S{20,200})$/.exec(request.headers.authorization ?? '');
  return match?.[1];
};

/**
 * Where targets' collectors send their applications' metrics, traces and logs, over
 * OTLP/HTTP as JSON, the way OTLP lays out its paths. Collectors have no session: each
 * request carries the target's telemetry token. Bodies are parsed, and unpacked when
 * gzipped, before they get here, up to 8 MB.
 */
@Controller('telemetry/v1')
@Public()
@SkipThrottle()
export class TelemetryController {
  readonly #gateway: TelemetryGateway;

  constructor(@Inject(TelemetryGateway) gateway: TelemetryGateway) {
    this.#gateway = gateway;
  }

  /** Answers as OTLP does, with an empty response: every resource was taken, or dropped on purpose. */
  @Post(':kind')
  @HttpCode(200)
  async receive(@Req() request: ApiRequest, @Param('kind') kind: string, @Body() body: unknown): Promise<Record<string, never>> {
    await this.#gateway.receive(kind, bearer(request), body);
    return {};
  }
}
