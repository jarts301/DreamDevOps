import {
  BranchCreated,
  BranchDeleted,
  CodePushed,
  type GitChange,
  PullRequestMerged,
  PullRequestUpdated,
} from '@dreamdevops/contracts/webhooks/events';
import { type CompanyId, type DomainEvent, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { repositoryOf, translate } from '../domain/forgejo-events.ts';
import { isValidSignature, webhookSecret } from '@dreamdevops/contracts/webhooks/signature';
import type { DeliveriesStore } from './ports.ts';

const NO_COMPANY = parseCompanyId('00000000-0000-0000-0000-000000000000');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Delivery {
  readonly event: string | undefined;
  readonly deliveryId: string | undefined;
  readonly signature: string | undefined;
  readonly body: Buffer | undefined;
}

export type DeliveryOutcome = 'accepted' | 'duplicate' | 'ignored' | 'rejected';

/**
 * Turns signed Forgejo webhooks into domain events. A delivery is accepted only with a
 * valid signature from the repository's own secret, and only once.
 */
export class WebhookGateway {
  readonly #store: DeliveriesStore;
  readonly #secretKey: string;

  constructor(store: DeliveriesStore, secretKey: string) {
    this.#store = store;
    this.#secretKey = secretKey;
  }

  async receive(delivery: Delivery): Promise<DeliveryOutcome> {
    const { event, deliveryId, signature, body } = delivery;
    if (event === undefined || deliveryId === undefined || !UUID_PATTERN.test(deliveryId) || body === undefined) {
      return 'rejected';
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      return 'rejected';
    }
    const repository = repositoryOf(payload);
    if (repository === null) {
      return 'rejected';
    }
    const owner = await runWithCompany(NO_COMPANY, () =>
      this.#store.transaction((session) => session.ownerOf(repository.organization, repository.name)),
    );
    // An unknown repository and a bad signature get the same answer, so neither is revealed.
    if (owner === null || !isValidSignature(webhookSecret(this.#secretKey, owner.applicationId), body, signature)) {
      return 'rejected';
    }

    const companyId = parseCompanyId(owner.companyId);
    return runWithCompany(companyId, () =>
      this.#store.transaction(async (session) => {
        if (!(await session.take({ deliveryId, companyId, applicationId: owner.applicationId, event }))) {
          return 'duplicate' as const;
        }
        const events = translate(event, payload);
        if (events.length === 0) {
          return 'ignored' as const;
        }
        await session.record(events.map((change) => toEvent(change, companyId, owner.applicationId)));
        return 'accepted' as const;
      }),
    );
  }
}

/** A change in an application's repository, as the event its contract defines. */
function toEvent(change: GitChange, companyId: CompanyId, applicationId: string): DomainEvent {
  switch (change.eventType) {
    case 'CodePushed':
      return CodePushed.create({ companyId, payload: { applicationId, ...change.payload } });
    case 'BranchCreated':
      return BranchCreated.create({ companyId, payload: { applicationId, ...change.payload } });
    case 'BranchDeleted':
      return BranchDeleted.create({ companyId, payload: { applicationId, ...change.payload } });
    case 'PullRequestUpdated':
      return PullRequestUpdated.create({ companyId, payload: { applicationId, ...change.payload } });
    case 'PullRequestMerged':
      return PullRequestMerged.create({ companyId, payload: { applicationId, ...change.payload } });
  }
}
