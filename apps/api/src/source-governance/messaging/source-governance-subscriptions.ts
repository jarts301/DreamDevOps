import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AppConfig } from '../../config/app-config.ts';
import type { ApplicationArchived, ApplicationRegistered, ApplicationRestored } from '../../catalog/domain/events.ts';
import type { RepositoryRequested } from '../domain/events.ts';
import { REPOSITORY_TRIGGERS, type Repositories } from '../application/repositories.ts';
import { ACCESS_TRIGGERS, type SourceAccess } from '../application/source-access.ts';

/** Creates repositories, keeps them read-only while archived, and keeps teams in line with roles. */
export class SourceGovernanceSubscriptions implements BackgroundSubscriber {
  readonly #repositories: Repositories;
  readonly #access: SourceAccess;
  readonly #config: AppConfig;

  constructor(repositories: Repositories, access: SourceAccess, config: AppConfig) {
    this.#repositories = repositories;
    this.#access = access;
    this.#config = config;
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
  }
}
