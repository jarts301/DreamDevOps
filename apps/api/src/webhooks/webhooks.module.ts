import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { DELIVERIES_STORE, type DeliveriesStore } from './application/ports.ts';
import { WebhookGateway } from './application/webhook-gateway.ts';
import { WebhooksController } from './http/webhooks.controller.ts';
import { postgresDeliveriesStore } from './infrastructure/postgres-deliveries-store.ts';

/** Takes Forgejo's signed webhooks and turns them into the platform's events. */
@Module({})
export class WebhooksModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, WebhooksModule, () => ({
      module: WebhooksModule,
      controllers: [WebhooksController],
      providers: withOverrides(
        [
          { provide: DELIVERIES_STORE, useFactory: postgresDeliveriesStore, inject: [TenantDatabase] },
          {
            provide: WebhookGateway,
            useFactory: (store: DeliveriesStore) => new WebhookGateway(store, settings.config.webhookSecretKey),
            inject: [DELIVERIES_STORE],
          },
        ],
        settings.overrides,
      ),
    }));
  }
}
