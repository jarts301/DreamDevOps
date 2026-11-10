import { randomUUID } from 'node:crypto';
import { createDomainEvent, currentCompanyId, isUuid } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { ApplicationCatalog } from '../../catalog/application/application-catalog.ts';
import { hasPermissions, type Principal } from '../../identity-access/domain/access.ts';
import { assertCurrentVersion, parseVersion } from '../domain/environment.ts';
import { EnvironmentError } from '../domain/errors.ts';
import type { EnvironmentVariablePayload, EnvironmentVariableSetPayload } from '../domain/events.ts';
import { authorizeChange } from '../domain/protection.ts';
import type { SealedSecret, SecretBox } from '../domain/secret-box.ts';
import { assertWithinLimits, parseVariableName, parseVariableValue } from '../domain/variables.ts';
import { type EnvironmentRow, findEnvironment, lockEnvironment, parseEnvironmentId } from './environments.ts';
import { MANAGE_PRODUCTION } from './hosting-targets.ts';

export interface VariableView {
  readonly id: string;
  readonly environmentId: string;
  readonly name: string;
  readonly secret: boolean;
  /** A plain variable's value. A secret's is never shown, so it's null. */
  readonly value: string | null;
  /** Send it back with a change, so nobody overwrites a change they haven't seen. */
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: { readonly userId: string; readonly displayName: string | null } | null;
}

interface VariableRow {
  id: string;
  environment_id: string;
  name: string;
  secret: boolean;
  value: string | null;
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  tag: Buffer | null;
  key_id: string | null;
  version: number;
  updated_at: Date;
  updated_by: string | null;
  updated_by_name: string | null;
}

/** What a change to production's variables comes with: its name typed, and a reason. */
interface Confirmation {
  readonly confirmation?: unknown;
  readonly reason?: unknown;
}

/** An environment's settings, ready for a container: every value, and which names are secret. */
export interface ResolvedVariables {
  readonly values: Readonly<Record<string, string>>;
  readonly variables: readonly string[];
  readonly secrets: readonly string[];
  /** The environment's settings revision they were read at. */
  readonly revision: number;
}

/**
 * Each environment's variables and secrets, which its containers get when they start.
 * Plain variables can be read by every member. Secrets are sealed as soon as they arrive,
 * and their values are never shown again, only replaced or removed.
 *
 * Changes apply the next time a version starts in the environment. Production's need
 * the permission to manage production, its name typed exactly, and a reason.
 */
export class EnvironmentVariables {
  readonly #database: TenantDatabase;
  readonly #catalog: ApplicationCatalog;
  readonly #box: SecretBox;

  constructor(database: TenantDatabase, catalog: ApplicationCatalog, box: SecretBox) {
    this.#database = database;
    this.#catalog = catalog;
    this.#box = box;
  }

  /** The environment's variables and secrets, by name. Secrets come without values. */
  async list(environmentId: unknown): Promise<VariableView[]> {
    const id = parseEnvironmentId(environmentId);
    return this.#database.transaction(async (tx) => {
      if ((await findEnvironment(tx, id)) === null) {
        throw new EnvironmentError('not-found', 'This environment does not exist.');
      }
      const { rows } = await tx.query<VariableRow>(
        'SELECT * FROM environments.variables WHERE environment_id = $1 ORDER BY upper(name)',
        [id],
      );
      return rows.map(toView);
    });
  }

  async add(
    actor: Principal,
    environmentId: unknown,
    input: Confirmation & { name?: unknown; value?: unknown; secret?: unknown },
  ): Promise<VariableView> {
    const id = parseEnvironmentId(environmentId);
    const name = parseVariableName(input.name);
    if (input.secret !== undefined && typeof input.secret !== 'boolean') {
      throw new EnvironmentError('invalid', 'Say whether it’s a secret.');
    }
    const secret = input.secret === true;
    const value = parseVariableValue(input.value, { secret });
    return this.#database.transaction(async (tx) => {
      const { environment, reason } = await this.#lockForChange(tx, actor, id, input);
      const { rows: taken } = await tx.query<{ name: string }>(
        'SELECT name FROM environments.variables WHERE environment_id = $1 AND upper(name) = upper($2)',
        [id, name],
      );
      if (taken[0] !== undefined) {
        throw new EnvironmentError('conflict', `${environment.name} already has ${taken[0].name}. Change it instead.`);
      }
      await this.#assertWithinLimits(tx, id, value, null);
      const variableId = randomUUID();
      const sealed = secret ? this.#box.seal(value, { companyId: currentCompanyId(), environmentId: id, name }) : null;
      await tx.query(
        `INSERT INTO environments.variables
           (id, company_id, environment_id, name, secret, value, ciphertext, nonce, tag, key_id,
            created_by, updated_by, updated_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12)`,
        [
          variableId,
          currentCompanyId(),
          id,
          name,
          secret,
          secret ? null : value,
          sealed?.ciphertext ?? null,
          sealed?.nonce ?? null,
          sealed?.tag ?? null,
          sealed?.keyId ?? null,
          actor.userId,
          actor.displayName,
        ],
      );
      await this.#changed(tx, actor, environment, 'EnvironmentVariableSet', { name, secret, change: 'added' }, reason);
      return toView((await findVariable(tx, variableId))!);
    });
  }

  /** Replaces a value. A secret stays a secret, and a name stays the same: remove it and add another instead. */
  async change(actor: Principal, variableId: unknown, input: Confirmation & { value?: unknown; version?: unknown }): Promise<VariableView> {
    const id = parseVariableId(variableId);
    const version = parseVersion(input.version);
    return this.#database.transaction(async (tx) => {
      const current = await this.#variable(tx, id);
      const { environment, reason } = await this.#lockForChange(tx, actor, current.environment_id, input);
      const locked = (await findVariable(tx, id, { forUpdate: true }))!;
      assertCurrentVersion(version, locked.version);
      const value = parseVariableValue(input.value, { secret: locked.secret });
      await this.#assertWithinLimits(tx, locked.environment_id, value, id);
      const sealed = locked.secret
        ? this.#box.seal(value, { companyId: currentCompanyId(), environmentId: locked.environment_id, name: locked.name })
        : null;
      await tx.query(
        `UPDATE environments.variables
         SET value = $2, ciphertext = $3, nonce = $4, tag = $5, key_id = $6, version = version + 1,
             updated_by = $7, updated_by_name = $8, updated_at = now()
         WHERE id = $1`,
        [
          id,
          locked.secret ? null : value,
          sealed?.ciphertext ?? null,
          sealed?.nonce ?? null,
          sealed?.tag ?? null,
          sealed?.keyId ?? null,
          actor.userId,
          actor.displayName,
        ],
      );
      await this.#changed(
        tx,
        actor,
        environment,
        'EnvironmentVariableSet',
        { name: locked.name, secret: locked.secret, change: 'changed' },
        reason,
      );
      return toView((await findVariable(tx, id))!);
    });
  }

  async remove(actor: Principal, variableId: unknown, input: Confirmation & { version?: unknown }): Promise<void> {
    const id = parseVariableId(variableId);
    const version = parseVersion(input.version);
    await this.#database.transaction(async (tx) => {
      const current = await this.#variable(tx, id);
      const { environment, reason } = await this.#lockForChange(tx, actor, current.environment_id, input);
      const locked = (await findVariable(tx, id, { forUpdate: true }))!;
      assertCurrentVersion(version, locked.version);
      await tx.query('DELETE FROM environments.variables WHERE id = $1', [id]);
      await this.#changed(tx, actor, environment, 'EnvironmentVariableRemoved', { name: locked.name, secret: locked.secret }, reason);
    });
  }

  /**
   * Reads every value, opening secrets, for a container that's about to start. Throws a
   * SecretUnreadableError if a secret can't be opened with this server's key.
   */
  async resolve(environmentId: string): Promise<ResolvedVariables> {
    return this.#database.transaction(async (tx) => {
      const { rows: environments } = await tx.query<{ settings_revision: number }>(
        'SELECT settings_revision FROM environments.environments WHERE id = $1',
        [environmentId],
      );
      const { rows } = await tx.query<VariableRow>(
        'SELECT * FROM environments.variables WHERE environment_id = $1 ORDER BY upper(name)',
        [environmentId],
      );
      const values: Record<string, string> = {};
      for (const row of rows) {
        values[row.name] = row.secret
          ? this.#box.open(sealedOf(row), { companyId: currentCompanyId(), environmentId, name: row.name })
          : row.value!;
      }
      return {
        values,
        variables: rows.filter((row) => !row.secret).map((row) => row.name),
        secrets: rows.filter((row) => row.secret).map((row) => row.name),
        revision: environments[0]?.settings_revision ?? 0,
      };
    });
  }

  /**
   * Locks the environment, so changes to its variables happen one at a time, and applies
   * the rules: it must be active, and production needs more.
   */
  async #lockForChange(
    tx: TenantTransaction,
    actor: Principal,
    environmentId: string,
    input: Confirmation,
  ): Promise<{ environment: EnvironmentRow; reason: string | null }> {
    const environment = await lockEnvironment(tx, environmentId);
    if (environment.status === 'archived') {
      throw new EnvironmentError('conflict', 'Restore the environment first.');
    }
    const reason = authorizeChange(environment, 'change-variables', {
      canManageProduction: hasPermissions(actor, [MANAGE_PRODUCTION]),
      confirmation: input.confirmation,
      reason: input.reason,
    });
    return { environment, reason };
  }

  async #variable(tx: TenantTransaction, id: string): Promise<VariableRow> {
    const variable = await findVariable(tx, id);
    if (variable === null) {
      throw new EnvironmentError('not-found', 'This variable does not exist.');
    }
    return variable;
  }

  /** The limits count every value, with a changed one's new value in place of its old one. */
  async #assertWithinLimits(tx: TenantTransaction, environmentId: string, value: string, replacing: string | null): Promise<void> {
    const { rows } = await tx.query<{ id: string; size: number }>(
      'SELECT id, coalesce(octet_length(value), octet_length(ciphertext)) AS size FROM environments.variables WHERE environment_id = $1',
      [environmentId],
    );
    // A sealed secret is as long as its value, so stored sizes count as the values' sizes.
    const others = rows.filter((row) => row.id !== replacing).map((row) => row.size);
    assertWithinLimits([...others, Buffer.byteLength(value, 'utf8')]);
  }

  /** Records the change, without the value, and marks the environment's settings as changed. */
  async #changed(
    tx: TenantTransaction,
    actor: Principal,
    environment: EnvironmentRow,
    eventType: 'EnvironmentVariableSet' | 'EnvironmentVariableRemoved',
    details: { name: string; secret: boolean; change?: 'added' | 'changed' },
    reason: string | null,
  ): Promise<void> {
    await tx.query('UPDATE environments.environments SET settings_revision = settings_revision + 1 WHERE id = $1', [
      environment.id,
    ]);
    const payload: EnvironmentVariablePayload = {
      environmentId: environment.id,
      environmentName: environment.name,
      applicationId: environment.application_id,
      applicationName: (await this.#catalog.get(environment.application_id)).name,
      production: environment.production,
      name: details.name,
      secret: details.secret,
      reason,
    };
    await appendToOutbox(tx, [
      eventType === 'EnvironmentVariableSet'
        ? createDomainEvent<'EnvironmentVariableSet', EnvironmentVariableSetPayload>({
            eventType,
            companyId: currentCompanyId(),
            actorId: actor.userId,
            payload: { ...payload, change: details.change ?? 'changed' },
          })
        : createDomainEvent<'EnvironmentVariableRemoved', EnvironmentVariablePayload>({
            eventType,
            companyId: currentCompanyId(),
            actorId: actor.userId,
            payload,
          }),
    ]);
  }
}

function parseVariableId(value: unknown): string {
  if (!isUuid(value)) {
    throw new EnvironmentError('invalid', 'The variable ID is not valid.');
  }
  return value;
}

async function findVariable(tx: TenantTransaction, id: string, options: { forUpdate?: boolean } = {}): Promise<VariableRow | null> {
  const { rows } = await tx.query<VariableRow>(
    `SELECT * FROM environments.variables WHERE id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

function sealedOf(row: VariableRow): SealedSecret {
  return { ciphertext: row.ciphertext!, nonce: row.nonce!, tag: row.tag!, keyId: row.key_id! };
}

function toView(row: VariableRow): VariableView {
  return {
    id: row.id,
    environmentId: row.environment_id,
    name: row.name,
    secret: row.secret,
    value: row.secret ? null : row.value,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by === null ? null : { userId: row.updated_by, displayName: row.updated_by_name },
  };
}
