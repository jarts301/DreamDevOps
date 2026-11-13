import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { WebhookGateway } from './application/webhook-gateway.ts';
import { WebhooksController } from './http/webhooks.controller.ts';

/** Takes Forgejo's signed webhooks and turns them into the platform's events. */
@Module({})
export class WebhooksModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, WebhooksModule, () => ({
      module: WebhooksModule,
      controllers: [WebhooksController],
      providers: withOverrides(
        [
          {
            provide: WebhookGateway,
            useFactory: (database: TenantDatabase) => new WebhookGateway(database, settings.config.webhookSecretKey),
            inject: [TenantDatabase],
          },
        ],
        settings.overrides,
      ),
    }));
  }
}
