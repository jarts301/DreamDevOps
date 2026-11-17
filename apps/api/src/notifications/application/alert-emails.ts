import type { Mailer } from './ports.ts';

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

const SUBJECT_PREFIXES: Readonly<Record<AlertEmailKind, string>> = {
  firing: '[Firing]',
  resolved: '[Resolved]',
  test: '[Test]',
};

/**
 * Emails the members an alert names when it fires and when it's resolved. Each email goes
 * through a background job, so a failure throws, and the job tries again.
 */
export class AlertEmails {
  readonly #mailer: Mailer;
  readonly #dashboardUrl: string;

  constructor(mailer: Mailer, dashboardUrl: string) {
    this.#mailer = mailer;
    this.#dashboardUrl = dashboardUrl;
  }

  async send(email: AlertEmail): Promise<void> {
    // Such as: Billing API in the production environment "Production".
    const where = `${email.applicationName} in the ${email.production ? 'production ' : ''}environment "${email.environmentName}"`;
    await this.#mailer.send({
      to: email.to,
      subject: `${SUBJECT_PREFIXES[email.kind]} ${email.alertName}: ${email.applicationName} in ${email.environmentName}`,
      text: [...this.#body(email, where), '', 'See your alerts on the dashboard:', this.#link(), '', footer(email)].join('\n'),
    });
  }

  #body(email: AlertEmail, where: string): string[] {
    switch (email.kind) {
      case 'firing':
        return [
          `${email.companyName}: the alert "${email.alertName}" is firing.`,
          '',
          `It watches ${where} for ${email.condition}.`,
          `Latest value: ${email.value}`,
          `Firing since: ${dateText(email.firingSince ?? email.at)}`,
        ];
      case 'resolved':
        return [
          `${email.companyName}: the alert "${email.alertName}" is resolved.`,
          '',
          `It watches ${where} for ${email.condition}, which no longer holds.`,
          `Latest value: ${email.value}`,
          ...(email.firingSince === null
            ? []
            : [`It fired from ${dateText(email.firingSince)} to ${dateText(email.at)}, for ${durationText(email.firingSince, email.at)}.`]),
        ];
      case 'test':
        return [
          `${email.companyName}: this is a test of the alert "${email.alertName}".`,
          '',
          `It watches ${where} for ${email.condition}.`,
          `Latest value: ${email.value}`,
          '',
          'Nothing is wrong: someone sent this to check that the alert’s emails arrive.',
        ];
    }
  }

  #link(): string {
    return new URL('alerts', `${this.#dashboardUrl.replace(/\/$/, '')}/`).toString();
  }
}

function footer(email: AlertEmail): string {
  return `You get this email because the alert "${email.alertName}" names you, as a member of ${email.companyName} on DreamDevOps.`;
}

/** Such as "Tue, 10 Nov 2026 12:30 UTC". Emails can't know the reader's time zone. */
function dateText(iso: string): string {
  return `${new Date(iso).toUTCString().slice(0, 22)} UTC`;
}

/** Such as "1 minute", "12 minutes" or "2 hours 5 minutes". */
function durationText(fromIso: string, toIso: string): string {
  const minutes = Math.max(1, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const minutesText = `${rest} ${rest === 1 ? 'minute' : 'minutes'}`;
  if (hours === 0) {
    return minutesText;
  }
  const hoursText = `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return rest === 0 ? hoursText : `${hoursText} ${minutesText}`;
}
