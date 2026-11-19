import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { AlertEmails } from './application/alert-emails.ts';
import { CompanyNames } from './application/company-names.ts';
import { InvitationEmails } from './application/invitation-emails.ts';
import { NotificationRules } from './application/notification-rules.ts';
import { ALERT_MAILER, COMPANY_NAMES, INVITATION_MAILER } from '@dreamdevops/contracts/notifications/services';
import {
  COMPANY_NAMES_STORE,
  type CompanyNamesStore,
  MAILER,
  type Mailer,
  RULES_STORE,
  type RulesStore,
  WEBHOOK_SENDER,
  type WebhookSender,
} from './application/ports.ts';
import { NotificationRulesController } from './http/notification-rules.controller.ts';
import { postgresCompanyNamesStore } from './infrastructure/postgres-company-names-store.ts';
import { postgresRulesStore } from './infrastructure/postgres-rules-store.ts';
import { SafeWebhookSender } from './infrastructure/safe-webhook-sender.ts';
import { SmtpMailer } from './infrastructure/smtp-mailer.ts';
import { NotificationsSubscriptions } from './messaging/notifications-subscriptions.ts';

/**
 * Invitation and alert emails, and company rules that post chosen events to chat tools. It
 * calls no other context: it keeps the company names its messages need from Tenancy's events.
 */
@Module({})
export class NotificationsModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, NotificationsModule, () => {
      const { config } = settings;
      return {
        module: NotificationsModule,
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
            { provide: COMPANY_NAMES_STORE, useFactory: postgresCompanyNamesStore, inject: [TenantDatabase] },
            { provide: CompanyNames, useFactory: (store: CompanyNamesStore) => new CompanyNames(store), inject: [COMPANY_NAMES_STORE] },
            // What the platform tells the names of companies made before Notifications kept them.
            { provide: COMPANY_NAMES, useExisting: CompanyNames },
            {
              provide: NotificationRules,
              useFactory: (store: RulesStore, companies: CompanyNames, sender: WebhookSender) =>
                new NotificationRules(store, companies, sender, { allowInsecureWebhooks: config.webhookAllowInsecure }),
              inject: [RULES_STORE, CompanyNames, WEBHOOK_SENDER],
            },
            {
              provide: NotificationsSubscriptions,
              useFactory: (rules: NotificationRules, names: CompanyNames) => new NotificationsSubscriptions(rules, names, config),
              inject: [NotificationRules, CompanyNames],
            },
          ],
          settings.overrides,
        ),
        exports: [INVITATION_MAILER, ALERT_MAILER, COMPANY_NAMES, NotificationsSubscriptions],
      };
    });
  }
}
