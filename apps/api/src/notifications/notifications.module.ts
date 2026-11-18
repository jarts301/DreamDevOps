import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { COMPANY_DIRECTORY, type CompanyDirectory } from '@dreamdevops/contracts/tenancy/services';
import { CompanyDirectoryModule } from '../tenancy/company-directory.module.ts';
import { AlertEmails } from './application/alert-emails.ts';
import { InvitationEmails } from './application/invitation-emails.ts';
import { NotificationRules } from './application/notification-rules.ts';
import { ALERT_MAILER, INVITATION_MAILER } from '@dreamdevops/contracts/notifications/services';
import { MAILER, type Mailer, RULES_STORE, type RulesStore, WEBHOOK_SENDER, type WebhookSender } from './application/ports.ts';
import { NotificationRulesController } from './http/notification-rules.controller.ts';
import { postgresRulesStore } from './infrastructure/postgres-rules-store.ts';
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
              useFactory: (mailer: Mailer) => new InvitationEmails(mailer, config.dashboardUrl, new Logger(InvitationEmails.name)),
              inject: [MAILER],
            },
            {
              provide: AlertEmails,
              useFactory: (mailer: Mailer) => new AlertEmails(mailer, config.dashboardUrl),
              inject: [MAILER],
            },
            // What other contexts send emails through.
            { provide: INVITATION_MAILER, useExisting: InvitationEmails },
            { provide: ALERT_MAILER, useExisting: AlertEmails },
            {
              provide: WEBHOOK_SENDER,
              useFactory: () => new SafeWebhookSender({ allowPrivateNetworks: config.webhookAllowPrivateNetworks }),
            },
            { provide: RULES_STORE, useFactory: postgresRulesStore, inject: [TenantDatabase] },
            {
              provide: NotificationRules,
              useFactory: (store: RulesStore, companies: CompanyDirectory, sender: WebhookSender) =>
                new NotificationRules(store, companies, sender, { allowInsecureWebhooks: config.webhookAllowInsecure }),
              inject: [RULES_STORE, COMPANY_DIRECTORY, WEBHOOK_SENDER],
            },
            {
              provide: NotificationsSubscriptions,
              useFactory: (rules: NotificationRules) => new NotificationsSubscriptions(rules, config),
              inject: [NotificationRules],
            },
          ],
          settings.overrides,
        ),
        exports: [INVITATION_MAILER, ALERT_MAILER, NotificationsSubscriptions],
      };
    });
  }
}
