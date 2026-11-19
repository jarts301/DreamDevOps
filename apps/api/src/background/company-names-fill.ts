import { Logger } from '@nestjs/common';
import type { CompanyNames } from '@dreamdevops/contracts/notifications/services';
import type { CompanyDirectory } from '@dreamdevops/contracts/tenancy/services';
import { describeError, deterministicJobId } from '@dreamdevops/shared-kernel';
import type { BackgroundSubscriber, BackgroundWork } from './background-subscriber.ts';

/** Tells Notifications the names of companies made before it kept them itself. */
export const COMPANY_NAMES_FILL_QUEUE = 'platform.fill-company-names';

/**
 * Notifications keeps company names from Tenancy's events, so it never calls Tenancy. Companies
 * made before it did had their events long ago, so the platform tells it their names once, from
 * Tenancy's directory. That's the platform's job, not Notifications', so neither context calls
 * the other. Names already heard from an event are kept, as they're newer.
 *
 * A job rather than work at every start: its ID is fixed, so however many API processes start,
 * the names are filled once, and a slow database doesn't hold up the start.
 */
export class CompanyNamesFill implements BackgroundSubscriber {
  readonly #logger = new Logger(CompanyNamesFill.name);
  readonly #directory: CompanyDirectory;
  readonly #names: CompanyNames;

  constructor(directory: CompanyDirectory, names: CompanyNames) {
    this.#directory = directory;
    this.#names = names;
  }

  async subscribe({ queue }: BackgroundWork): Promise<void> {
    await queue.createQueue(COMPANY_NAMES_FILL_QUEUE, { retryLimit: 5, retryDelaySeconds: 60, expireInSeconds: 3_600 });
    await queue.work(COMPANY_NAMES_FILL_QUEUE, () => this.fill());
    await queue.send(COMPANY_NAMES_FILL_QUEUE, {}, { id: deterministicJobId(COMPANY_NAMES_FILL_QUEUE, '1') });
  }

  /** Each company's name, to Notifications, unless it has one already. */
  async fill(): Promise<void> {
    let failed = 0;
    for (const company of await this.#directory.all()) {
      try {
        await this.#names.rememberIfUnknown(company.id, company.name);
      } catch (error) {
        failed += 1;
        this.#logger.error(`Telling Notifications the name of company ${company.id} failed: ${describeError(error)}`);
      }
    }
    if (failed > 0) {
      // Thrown so the job is tried again. Names already kept are left as they are.
      throw new Error(`The names of ${failed} companies weren't kept.`);
    }
  }
}
