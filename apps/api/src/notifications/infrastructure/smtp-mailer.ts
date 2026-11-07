import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailMessage, Mailer } from '../application/ports.ts';

export interface SmtpOptions {
  readonly host: string;
  readonly port: number;
  readonly from: string;
  /** "tls" connects with TLS, "starttls" requires upgrading, "none" is for local mail catchers only. */
  readonly security: 'tls' | 'starttls' | 'none';
  readonly username: string | null;
  readonly password: string | null;
}

export class SmtpMailer implements Mailer {
  readonly #transport: Transporter;
  readonly #from: string;

  constructor(options: SmtpOptions) {
    this.#from = options.from;
    this.#transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.security === 'tls',
      requireTLS: options.security === 'starttls',
      ignoreTLS: options.security === 'none',
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      ...(options.username !== null && { auth: { user: options.username, pass: options.password ?? '' } }),
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.#transport.sendMail({ from: this.#from, to: message.to, subject: message.subject, text: message.text });
  }
}
