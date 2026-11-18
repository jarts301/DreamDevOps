import {
  BranchCreated,
  BranchDeleted,
  CodePushed,
  type GitChange,
  PullRequestMerged,
  PullRequestUpdated,
} from '@dreamdevops/contracts/webhooks/events';
import { type CompanyId, type DomainEvent, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { repositoryOf, translate } from '../domain/forgejo-events.ts';
import { isValidSignature, webhookSecret } from '@dreamdevops/contracts/webhooks/signature';

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
  readonly #database: TenantDatabase;
  readonly #secretKey: string;

  constructor(database: TenantDatabase, secretKey: string) {
    this.#database = database;
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
      this.#database.transaction(async (tx) => {
        const { rows } = await tx.query<{ application_id: string; company_id: string }>(
          'SELECT * FROM webhooks.repository_owner($1, $2)',
          [repository.organization, repository.name],
        );
        return rows[0];
      }),
    );
    // An unknown repository and a bad signature get the same answer, so neither is revealed.
    if (owner === undefined || !isValidSignature(webhookSecret(this.#secretKey, owner.application_id), body, signature)) {
      return 'rejected';
    }

    const companyId = parseCompanyId(owner.company_id);
    return runWithCompany(companyId, () =>
      this.#database.transaction(async (tx) => {
        const { rowCount } = await tx.query(
          `INSERT INTO webhooks.deliveries (delivery_id, company_id, application_id, event)
           VALUES ($1, $2, $3, $4) ON CONFLICT (delivery_id) DO NOTHING`,
          [deliveryId, companyId, owner.application_id, event],
        );
        if (rowCount === 0) {
          return 'duplicate' as const;
        }
        const events = translate(event, payload);
        if (events.length === 0) {
          return 'ignored' as const;
        }
        await appendToOutbox(
          tx,
          events.map((change) => toEvent(change, companyId, owner.application_id)),
        );
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
