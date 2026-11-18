import { roleName } from '@dreamdevops/contracts/identity-access/roles';
import type { InvitationEmail, InvitationMailer } from '@dreamdevops/contracts/notifications/services';
import type { Logger } from '@dreamdevops/shared-kernel';
import type { Mailer } from './ports.ts';

/**
 * Emails invitation links. The token is only ever in memory and in the email, so it's
 * sent straight after the invitation is saved rather than through a stored job.
 */
export class InvitationEmails implements InvitationMailer {
  readonly #mailer: Mailer;
  readonly #dashboardUrl: string;
  readonly #logger: Logger;

  constructor(mailer: Mailer, dashboardUrl: string, logger: Logger) {
    this.#mailer = mailer;
    this.#dashboardUrl = dashboardUrl;
    this.#logger = logger;
  }

  /** Returns whether the email was sent. A failure never undoes the invitation. */
  async send(email: InvitationEmail): Promise<boolean> {
    const link = new URL('invitations/accept', `${this.#dashboardUrl.replace(/\/$/, '')}/`);
    link.hash = `token=${encodeURIComponent(email.token)}`;
    const expires = new Date(email.expiresAt).toUTCString().slice(0, 16);
    try {
      await this.#mailer.send({
        to: email.to,
        subject: `You're invited to join ${email.companyName} on DreamDevOps`,
        text: [
          `${email.invitedBy} invited you to join ${email.companyName} on DreamDevOps as ${roleName(email.role)}.`,
          '',
          'Open this link to accept:',
          link.toString(),
          '',
          `The link works once and expires on ${expires}. Sign in with this email address to accept it.`,
          '',
          "If you weren't expecting this, you can ignore this email.",
        ].join('\n'),
      });
      return true;
    } catch (error) {
      // The message stays out of the log, because it contains the token.
      this.#logger.warn(`An invitation email could not be sent: ${error instanceof Error ? error.name : 'error'}`);
      return false;
    }
  }
}
