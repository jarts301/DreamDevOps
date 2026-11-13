import { type DynamicModule, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.ts';
import { AuditSubscriptions } from '../audit/messaging/audit-subscriptions.ts';
import { BuildsModule } from '../builds/builds.module.ts';
import { BuildsSubscriptions } from '../builds/messaging/builds-subscriptions.ts';
import { DeploymentsModule } from '../deployments/deployments.module.ts';
import { DeploymentsSubscriptions } from '../deployments/messaging/deployments-subscriptions.ts';
import { EnvironmentsModule } from '../environments/environments.module.ts';
import { EnvironmentsSubscriptions } from '../environments/messaging/environments-subscriptions.ts';
import { NotificationsSubscriptions } from '../notifications/messaging/notifications-subscriptions.ts';
import { NotificationsModule } from '../notifications/notifications.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { ReleasesSubscriptions } from '../releases/messaging/releases-subscriptions.ts';
import { ReleasesModule } from '../releases/releases.module.ts';
import { SourceGovernanceSubscriptions } from '../source-governance/messaging/source-governance-subscriptions.ts';
import { SourceGovernanceModule } from '../source-governance/source-governance.module.ts';
import { TenancySubscriptions } from '../tenancy/messaging/tenancy-subscriptions.ts';
import { TenancyModule } from '../tenancy/tenancy.module.ts';
import { BACKGROUND_SUBSCRIBERS, type BackgroundSubscriber } from './background-subscriber.ts';
import { BACKGROUND_PROCESSING, BackgroundProcessing } from './background-processing.ts';

/** Each module that works in the background, in the order its subscriptions are set up. */
const SUBSCRIBERS = [
  TenancySubscriptions,
  SourceGovernanceSubscriptions,
  BuildsSubscriptions,
  ReleasesSubscriptions,
  EnvironmentsSubscriptions,
  DeploymentsSubscriptions,
  AuditSubscriptions,
  NotificationsSubscriptions,
];

/** Runs the outbox relay and job queue, and lets each module set up its own background work. */
@Module({})
export class BackgroundModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, BackgroundModule, () => ({
      module: BackgroundModule,
      imports: [
        TenancyModule.register(settings),
        SourceGovernanceModule.register(settings),
        BuildsModule.register(settings),
        ReleasesModule.register(settings),
        EnvironmentsModule.register(settings),
        DeploymentsModule.register(settings),
        AuditModule.register(settings),
        NotificationsModule.register(settings),
      ],
      providers: withOverrides(
        [
          {
            provide: BACKGROUND_SUBSCRIBERS,
            useFactory: (...subscribers: BackgroundSubscriber[]) => subscribers,
            inject: SUBSCRIBERS,
          },
          { provide: BACKGROUND_PROCESSING, useClass: BackgroundProcessing },
        ],
        settings.overrides,
      ),
    }));
  }
}
