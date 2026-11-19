import type { RuleKind } from '@dreamdevops/contracts/notifications/http';
import { currentCompanyId } from '@dreamdevops/shared-kernel';
import { PostgresSession, type TenantDatabase, transactional } from '@dreamdevops/shared-kernel/postgres';
import type { RulesSession, RulesStore, StoredRule } from '../application/ports.ts';

interface RuleRow {
  id: string;
  name: string;
  kind: RuleKind;
  url: string;
  event_types: string[];
  enabled: boolean;
  last_delivery_at: Date | null;
  last_error: string | null;
}

/** Each company's chat rules, in the notification schema. */
export function postgresRulesStore(database: TenantDatabase): RulesStore {
  return transactional(database, (tx) => new PostgresRulesSession(tx), { role: 'dreamdevops_notification' });
}

class PostgresRulesSession extends PostgresSession implements RulesSession {
  async list(): Promise<StoredRule[]> {
    const { rows } = await this.tx.query<RuleRow>('SELECT * FROM notification.rules ORDER BY lower(name), id');
    return rows.map(toRule);
  }

  async find(id: string): Promise<StoredRule | null> {
    const { rows } = await this.tx.query<RuleRow>('SELECT * FROM notification.rules WHERE id = $1', [id]);
    return rows[0] === undefined ? null : toRule(rows[0]);
  }

  async add(rule: {
    readonly name: string;
    readonly kind: RuleKind;
    readonly url: string;
    readonly eventTypes: readonly string[];
    readonly createdBy: string;
  }): Promise<StoredRule> {
    const { rows } = await this.tx.query<RuleRow>(
      `INSERT INTO notification.rules (company_id, name, kind, url, event_types, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [currentCompanyId(), rule.name, rule.kind, rule.url, rule.eventTypes, rule.createdBy],
    );
    return toRule(rows[0]!);
  }

  async update(
    id: string,
    changes: { readonly name: string | null; readonly eventTypes: readonly string[] | null; readonly enabled: boolean | null },
  ): Promise<StoredRule | null> {
    const { rows } = await this.tx.query<RuleRow>(
      `UPDATE notification.rules SET
         name = coalesce($2, name),
         event_types = coalesce($3, event_types),
         enabled = coalesce($4, enabled),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, changes.name, changes.eventTypes, changes.enabled],
    );
    return rows[0] === undefined ? null : toRule(rows[0]);
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.tx.query('DELETE FROM notification.rules WHERE id = $1', [id]);
    return rowCount !== 0;
  }

  async enabledFor(eventType: string): Promise<string[]> {
    const { rows } = await this.tx.query<{ id: string }>('SELECT id FROM notification.rules WHERE enabled AND $1 = ANY (event_types)', [
      eventType,
    ]);
    return rows.map((row) => row.id);
  }

  async recordDelivery(id: string, error: string | null): Promise<void> {
    await this.tx.query('UPDATE notification.rules SET last_delivery_at = now(), last_error = $2 WHERE id = $1', [id, error]);
  }
}

function toRule(row: RuleRow): StoredRule {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: row.url,
    eventTypes: row.event_types,
    enabled: row.enabled,
    lastDeliveryAt: row.last_delivery_at,
    lastError: row.last_error,
  };
}
