import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { COMPANY_DIRECTORY, type CompanyDirectory } from '../tenancy/application/company-directory.ts';
import { CompanyDirectoryModule } from '../tenancy/company-directory.module.ts';
import { AlertEmails } from './application/alert-emails.ts';
import { InvitationEmails } from './application/invitation-emails.ts';
import { NotificationRules } from './application/notification-rules.ts';
import { MAILER, type Mailer, WEBHOOK_SENDER, type WebhookSender } from './application/ports.ts';
import { NotificationRulesController } from './http/notification-rules.controller.ts';
import { SafeWebhookSender } from './infrastructure/safe-webhook-sender.ts';
import { SmtpMailer } from './infrastructure/smtp-mailer.ts';
import { NotificationsSubscriptions } from './messaging/notifications-subscriptions.ts';

/** Invitation and alert emails, and company rules that post chosen events to chat tools. */
@Module({})
export class NotificationsModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, NotificationsModule, () => {
      const { config } = settings;
      return {
        module: NotificationsModule,
        imports: [CompanyDirectoryModule.register(settings)],
        controllers: [NotificationRulesController],
        providers: withOverrides(
          [
            {
              provide: MAILER,
              useFactory: () =>
                new SmtpMailer({
                  host: config.smtpHost,
                  port: config.smtpPort,
                  from: config.smtpFrom,
                  security: config.smtpSecurity,
                  username: config.smtpUsername,
                  password: config.smtpPassword,
                }),
            },
            {
              provide: InvitationEmails,
              useFactory: (mailer: Mailer) => new InvitationEmails(mailer, config.dashboardUrl),
              inject: [MAILER],
            },
            {
              provide: AlertEmails,
              useFactory: (mailer: Mailer) => new AlertEmails(mailer, config.dashboardUrl),
              inject: [MAILER],
            },
            {
              provide: WEBHOOK_SENDER,
              useFactory: () => new SafeWebhookSender({ allowPrivateNetworks: config.webhookAllowPrivateNetworks }),
            },
            {
              provide: NotificationRules,
              useFactory: (database: TenantDatabase, companies: CompanyDirectory, sender: WebhookSender) =>
                new NotificationRules(database, companies, sender, { allowInsecureWebhooks: config.webhookAllowInsecure }),
              inject: [TenantDatabase, COMPANY_DIRECTORY, WEBHOOK_SENDER],
            },
            {
              provide: NotificationsSubscriptions,
              useFactory: (rules: NotificationRules) => new NotificationsSubscriptions(rules, config),
              inject: [NotificationRules],
            },
          ],
          settings.overrides,
        ),
        exports: [InvitationEmails, AlertEmails, NotificationsSubscriptions],
      };
    });
  }
}
