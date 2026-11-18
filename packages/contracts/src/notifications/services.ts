/** What Notifications does for other contexts: it sends their emails. */

/** An invitation to a company, to email to the person invited. */
export interface InvitationEmail {
  readonly to: string;
  readonly companyName: string;
  /** The role they're invited to, by its key, such as tech-lead. */
  readonly role: string;
  /** Who invited them, by name. */
  readonly invitedBy: string;
  /** The invitation's one-time token, which the email's link carries. It's never stored. */
  readonly token: string;
  readonly expiresAt: string;
}

export const INVITATION_MAILER = Symbol('INVITATION_MAILER');

/**
 * Emails invitation links. The token exists only in memory and in the email, so it's sent
 * straight after the invitation is made rather than through a stored job.
 */
export interface InvitationMailer {
  /** Returns whether the email was sent. A failure never undoes the invitation. */
  send(email: InvitationEmail): Promise<boolean>;
}

/** What an alert email is about: it started firing, it's resolved, or someone is checking that emails arrive. */
export type AlertEmailKind = 'firing' | 'resolved' | 'test';

/**
 * An alert email, with everything already in words, such as "CPU above 80%" and "92%",
 * because the context that watches the metrics knows how they read.
 */
export interface AlertEmail {
  readonly kind: AlertEmailKind;
  readonly to: string;
  readonly companyName: string;
  readonly alertName: string;
  readonly applicationName: string;
  readonly environmentName: string;
  readonly production: boolean;
  /** What it watches for, such as "CPU above 80% for 5 minutes". */
  readonly condition: string;
  /** The value that made it fire or resolve, such as "92%" or "No data". */
  readonly value: string;
  /** When it started firing, as an ISO date. */
  readonly firingSince: string | null;
  /** When it fired, resolved, or the test was sent, as an ISO date. */
  readonly at: string;
}

export const ALERT_MAILER = Symbol('ALERT_MAILER');

/** Emails the members an alert names. A failure throws, so the job that sends it tries again. */
export interface AlertMailer {
  send(email: AlertEmail): Promise<void>;
}
