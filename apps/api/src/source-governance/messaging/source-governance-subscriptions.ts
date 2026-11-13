import { Logger } from '@nestjs/common';
import { describeError, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import type { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AppConfig } from '../../config/app-config.ts';
import type { ApplicationArchived, ApplicationRegistered, ApplicationRestored } from '../../catalog/domain/events.ts';
import type { RepositoryRequested } from '../domain/events.ts';
import { POLICY_VERSION, REPOSITORY_TRIGGERS, type Repositories } from '../application/repositories.ts';
import { ACCESS_TRIGGERS, type SourceAccess } from '../application/source-access.ts';

const NO_COMPANY = parseCompanyId('00000000-0000-0000-0000-000000000000');

/**
 * Creates repositories, keeps them read-only while archived, and keeps teams in line with
 * roles. When the API starts, it brings repositories made under older rules up to date.
 */
export class SourceGovernanceSubscriptions implements BackgroundSubscriber {
  readonly #logger = new Logger(SourceGovernanceSubscriptions.name);
  readonly #repositories: Repositories;
  readonly #access: SourceAccess;
  readonly #config: AppConfig;
  readonly #database: TenantDatabase;

  constructor(repositories: Repositories, access: SourceAccess, config: AppConfig, database: TenantDatabase) {
    this.#repositories = repositories;
    this.#access = access;
    this.#config = config;
    this.#database = database;
  }

  async subscribe({ bus }: BackgroundWork): Promise<void> {
    const retries = {
      retryLimit: this.#config.provisioningMaxAttempts + 2,
      retryDelaySeconds: this.#config.provisioningRetrySeconds,
    };
    for (const eventType of REPOSITORY_TRIGGERS) {
      await bus.subscribe<ApplicationRegistered | RepositoryRequested>(
        eventType,
        'source-repositories',
        (event) => this.#repositories.provision(event.payload.applicationId),
        retries,
      );
    }
    for (const [eventType, archived] of [
      ['ApplicationArchived', true],
      ['ApplicationRestored', false],
    ] as const) {
      await bus.subscribe<ApplicationArchived | ApplicationRestored>(
        eventType,
        'source-archiving',
        (event) => this.#repositories.syncArchived(event.payload.applicationId, archived),
        retries,
      );
    }
    for (const eventType of ACCESS_TRIGGERS) {
      await bus.subscribe(eventType, 'source-access', () => this.#access.syncCompany(), retries);
    }
    // In the background, so a slow Git service doesn't hold up the start.
    void this.#upgradeRepositories().catch((error: unknown) => this.#logger.error(error));
  }

  /** Brings repositories made under older rules up to date, company by company. */
  async #upgradeRepositories(): Promise<void> {
    const companies = await runWithCompany(NO_COMPANY, () =>
      this.#database.transaction(async (tx) => {
        const { rows } = await tx.query<{ company_id: string }>(
          'SELECT * FROM source.companies_with_outdated_repositories($1)',
          [POLICY_VERSION],
        );
        return rows;
      }),
    );
    for (const { company_id: companyId } of companies) {
      await runWithCompany(parseCompanyId(companyId), () => this.#repositories.upgradePolicies()).catch((error: unknown) =>
        this.#logger.error(`Upgrading the repositories of ${companyId} failed: ${describeError(error)}`),
      );
    }
  }
}
