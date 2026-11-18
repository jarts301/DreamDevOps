import { PostgresSession, type TenantDatabase, transactional } from '@dreamdevops/shared-kernel/postgres';
import type { DeliveriesSession, DeliveriesStore, RepositoryOwner } from '../application/ports.ts';

/** The deliveries taken, in the webhooks schema. They're kept, so a replayed one is refused for good. */
export function postgresDeliveriesStore(database: TenantDatabase): DeliveriesStore {
  return transactional(database, (tx) => new PostgresDeliveriesSession(tx));
}

class PostgresDeliveriesSession extends PostgresSession implements DeliveriesSession {
  async ownerOf(organization: string, name: string): Promise<RepositoryOwner | null> {
    const { rows } = await this.tx.query<{ application_id: string; company_id: string }>(
      'SELECT * FROM webhooks.repository_owner($1, $2)',
      [organization, name],
    );
    return rows[0] === undefined ? null : { applicationId: rows[0].application_id, companyId: rows[0].company_id };
  }

  async take(delivery: {
    readonly deliveryId: string;
    readonly companyId: string;
    readonly applicationId: string;
    readonly event: string;
  }): Promise<boolean> {
    const { rowCount } = await this.tx.query(
      `INSERT INTO webhooks.deliveries (delivery_id, company_id, application_id, event)
       VALUES ($1, $2, $3, $4) ON CONFLICT (delivery_id) DO NOTHING`,
      [delivery.deliveryId, delivery.companyId, delivery.applicationId, delivery.event],
    );
    return rowCount !== 0;
  }
}
