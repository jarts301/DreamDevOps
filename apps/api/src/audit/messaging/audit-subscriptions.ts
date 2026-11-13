import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AuditLog } from '../application/audit-log.ts';

/** Records every event, of every module, in its company's history. */
export class AuditSubscriptions implements BackgroundSubscriber {
  readonly #audit: AuditLog;

  constructor(audit: AuditLog) {
    this.#audit = audit;
  }

  async subscribe({ bus }: BackgroundWork): Promise<void> {
    await bus.subscribeToAll('audit', (event) => this.#audit.record(event), { retryLimit: 10, retryDelaySeconds: 5 });
  }
}
