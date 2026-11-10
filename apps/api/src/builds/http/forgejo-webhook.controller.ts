import { Controller, HttpCode, Inject, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Public } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { ForgejoWebhooks } from '../infrastructure/forgejo-webhooks.ts';

/**
 * Forgejo calls this without a session, so it's public. Each delivery must carry a valid
 * signature from its repository's secret, or it's refused before anything is read.
 */
@Controller('hooks')
export class ForgejoWebhookController {
  readonly #webhooks: ForgejoWebhooks;

  constructor(@Inject(ForgejoWebhooks) webhooks: ForgejoWebhooks) {
    this.#webhooks = webhooks;
  }

  @Public()
  @Post('forgejo')
  @HttpCode(204)
  async receive(@Req() request: ApiRequest & { rawBody?: Buffer }): Promise<void> {
    const header = (name: string) => {
      const value = request.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    const outcome = await this.#webhooks.receive({
      event: header('x-forgejo-event') ?? header('x-gitea-event'),
      signature: header('x-forgejo-signature') ?? header('x-gitea-signature'),
      body: request.rawBody ?? Buffer.alloc(0),
    });
    if (outcome === 'rejected') {
      throw new UnauthorizedException('The webhook signature is not valid.');
    }
  }
}
