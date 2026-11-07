import { Controller, HttpCode, Inject, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Public } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { WebhookGateway } from '../application/webhook-gateway.ts';

const header = (request: ApiRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
};

/** Forgejo calls this. It has no session, so the signature is what proves who sent it. */
@Controller('webhooks')
export class WebhooksController {
  readonly #gateway: WebhookGateway;

  constructor(@Inject(WebhookGateway) gateway: WebhookGateway) {
    this.#gateway = gateway;
  }

  @Public()
  @Post('forgejo')
  @HttpCode(204)
  async forgejo(@Req() request: ApiRequest): Promise<void> {
    const outcome = await this.#gateway.receive({
      event: header(request, 'x-forgejo-event') ?? header(request, 'x-gitea-event'),
      deliveryId: header(request, 'x-forgejo-delivery') ?? header(request, 'x-gitea-delivery'),
      signature: header(request, 'x-forgejo-signature') ?? header(request, 'x-gitea-signature'),
      body: request.rawBody,
    });
    if (outcome === 'rejected') {
      throw new UnauthorizedException('This webhook could not be verified.');
    }
  }
}
