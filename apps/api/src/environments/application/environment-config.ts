import { randomUUID } from 'node:crypto';
import { createDomainEvent, currentCompanyId } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { Principal } from '../../identity-access/domain/access.ts';
import type { EnvironmentKind } from '../domain/environment.ts';
import { EnvironmentError } from '../domain/errors.ts';
import type { SecretStore } from './ports.ts';
import { secretsPath } from './target-configuration.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,99}$/;
const MAX_VARIABLE = 4096;
const MAX_SECRET = 16 * 1024;

/** Names the platform sets itself, which people can't override. */
const RESERVED_NAMES = new Set(['PORT', 'DREAMDEVOPS_ENVIRONMENT', 'DREAMDEVOPS_VERSION']);

export type ConfigScope = 'environment' | 'application';

export interface VariableView {
  readonly name: string;
  readonly value: string;
  readonly scope: ConfigScope;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

/** A secret shows only its name. Its value can be replaced or deleted, never read. */
export interface SecretView {
  readonly name: string;
  readonly scope: ConfigScope;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

export interface EnvironmentConfigView {
  readonly variables: readonly VariableView[];
  readonly secrets: readonly SecretView[];
}

/** What an application gets in an environment: its own values over the environment's. */
export interface ResolvedConfig {
  readonly variables: Readonly<Record<string, string>>;
  /** Where its secrets are in the store: the environment's shared ones, then its own. */
  readonly secretPaths: { readonly shared: string; readonly application: string };
  readonly hasSharedSecrets: boolean;
  readonly hasApplicationSecrets: boolean;
}

interface Row {
  name: string;
  value?: string;
  application_id: string | null;
  updated_at: Date;
  updated_by: string | null;
}

/**
 * Each environment's variables and secrets, for all its applications or for one. Secret
 * values go straight to the secret store; the database keeps only their names. Changes
 * apply at the next deployment.
 */
export class EnvironmentConfig {
  readonly #database: TenantDatabase;
  readonly #secrets: SecretStore;

  constructor(database: TenantDatabase, secrets: SecretStore) {
    this.#database = database;
    this.#secrets = secrets;
  }

  /** The environment's values, or with an application, its values and the environment's. */
  async view(environmentValue: unknown, applicationValue: unknown): Promise<EnvironmentConfigView> {
    const environmentId = parseId(environmentValue, 'environment');
    const applicationId = applicationValue === undefined || applicationValue === '' ? null : parseId(applicationValue, 'application');
    return this.#database.transaction(async (tx) => {
      await findEnvironment(tx, environmentId);
      if (applicationId !== null) {
        await findApplication(tx, applicationId);
      }
      const scoped = (table: 'variables' | 'secrets', columns: string) =>
        tx.query<Row>(
          `SELECT ${columns}, application_id, updated_at, updated_by FROM environments.${table}
           WHERE environment_id = $1 AND (application_id IS NULL OR application_id = $2)
           ORDER BY name, application_id NULLS FIRST`,
          [environmentId, applicationId],
        );
      const { rows: variables } = await scoped('variables', 'name, value');
      const { rows: secrets } = await scoped('secrets', 'name');
      const scope = (row: Row): ConfigScope => (row.application_id === null ? 'environment' : 'application');
      return {
        variables: variables.map((row) => ({
          name: row.name,
          value: row.value!,
          scope: scope(row),
          updatedAt: row.updated_at.toISOString(),
          updatedBy: row.updated_by,
        })),
        secrets: secrets.map((row) => ({
          name: row.name,
          scope: scope(row),
          updatedAt: row.updated_at.toISOString(),
          updatedBy: row.updated_by,
        })),
      };
    });
  }

  async setVariable(actor: Principal, environmentValue: unknown, nameValue: unknown, input: { value?: unknown; application?: unknown }): Promise<void> {
    const name = parseName(nameValue);
    if (typeof input.value !== 'string' || input.value.length > MAX_VARIABLE) {
      throw new EnvironmentError('invalid', `Enter a value of at most ${MAX_VARIABLE} characters.`);
    }
    const value = input.value;
    await this.#change(actor, environmentValue, input.application, async (tx, environmentId, applicationId) => {
      await assertNotSecret(tx, environmentId, applicationId, name);
      await tx.query(
        `INSERT INTO environments.variables (id, company_id, environment_id, application_id, name, value, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (environment_id, coalesce(application_id, '00000000-0000-0000-0000-000000000000'), name)
         DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
        [randomUUID(), currentCompanyId(), environmentId, applicationId, name, value, actor.userId],
      );
      return { eventType: 'EnvironmentVariableSet', name };
    });
  }

  async removeVariable(actor: Principal, environmentValue: unknown, nameValue: unknown, applicationValue: unknown): Promise<void> {
    const name = parseName(nameValue);
    await this.#change(actor, environmentValue, applicationValue, async (tx, environmentId, applicationId) => {
      const { rowCount } = await tx.query(
        `DELETE FROM environments.variables
         WHERE environment_id = $1 AND application_id IS NOT DISTINCT FROM $2 AND name = $3`,
        [environmentId, applicationId, name],
      );
      if (rowCount === 0) {
        throw new EnvironmentError('not-found', 'There is no such variable.');
      }
      return { eventType: 'EnvironmentVariableRemoved', name };
    });
  }

  /** Saves the value in the secret store, and only the name here. */
  async setSecret(actor: Principal, environmentValue: unknown, nameValue: unknown, input: { value?: unknown; application?: unknown }): Promise<void> {
    const name = parseName(nameValue);
    if (typeof input.value !== 'string' || input.value === '' || Buffer.byteLength(input.value) > MAX_SECRET) {
      throw new EnvironmentError('invalid', 'Enter a secret value of at most 16 KB.');
    }
    const value = input.value;
    await this.#change(actor, environmentValue, input.application, async (tx, environmentId, applicationId, application) => {
      const { rows } = await tx.query(
        `SELECT 1 FROM environments.variables
         WHERE environment_id = $1 AND application_id IS NOT DISTINCT FROM $2 AND name = $3`,
        [environmentId, applicationId, name],
      );
      if (rows.length > 0) {
        throw new EnvironmentError('conflict', 'A variable already has this name here.');
      }
      await tx.query(
        `INSERT INTO environments.secrets (id, company_id, environment_id, application_id, name, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (environment_id, coalesce(application_id, '00000000-0000-0000-0000-000000000000'), name)
         DO UPDATE SET updated_by = excluded.updated_by, updated_at = now()`,
        [randomUUID(), currentCompanyId(), environmentId, applicationId, name, actor.userId],
      );
      // Written last, inside the transaction: if the store refuses, the name isn't kept.
      await this.#secrets.write(secretPathOf(environmentId, application), { [name]: value });
      return { eventType: 'EnvironmentSecretSet', name };
    });
  }

  async removeSecret(actor: Principal, environmentValue: unknown, nameValue: unknown, applicationValue: unknown): Promise<void> {
    const name = parseName(nameValue);
    await this.#change(actor, environmentValue, applicationValue, async (tx, environmentId, applicationId, application) => {
      const { rowCount } = await tx.query(
        `DELETE FROM environments.secrets
         WHERE environment_id = $1 AND application_id IS NOT DISTINCT FROM $2 AND name = $3`,
        [environmentId, applicationId, name],
      );
      if (rowCount === 0) {
        throw new EnvironmentError('not-found', 'There is no such secret.');
      }
      await this.#secrets.remove(secretPathOf(environmentId, application), [name]);
      return { eventType: 'EnvironmentSecretRemoved', name };
    });
  }

  /** The variables an application gets in an environment, and where its secrets are. */
  async resolve(tx: TenantTransaction, environmentId: string, application: { id: string; slug: string }): Promise<ResolvedConfig> {
    const { rows } = await tx.query<{ name: string; value: string; application_id: string | null }>(
      `SELECT name, value, application_id FROM environments.variables
       WHERE environment_id = $1 AND (application_id IS NULL OR application_id = $2)
       ORDER BY application_id NULLS FIRST`,
      [environmentId, application.id],
    );
    const variables: Record<string, string> = {};
    for (const row of rows) {
      variables[row.name] = row.value;
    }
    const { rows: secrets } = await tx.query<{ application_id: string | null }>(
      `SELECT DISTINCT application_id FROM environments.secrets
       WHERE environment_id = $1 AND (application_id IS NULL OR application_id = $2)`,
      [environmentId, application.id],
    );
    return {
      variables,
      secretPaths: {
        shared: secretPathOf(environmentId, null),
        application: secretPathOf(environmentId, application.slug),
      },
      hasSharedSecrets: secrets.some((row) => row.application_id === null),
      hasApplicationSecrets: secrets.some((row) => row.application_id !== null),
    };
  }

  async #change(
    actor: Principal,
    environmentValue: unknown,
    applicationValue: unknown,
    work: (
      tx: TenantTransaction,
      environmentId: string,
      applicationId: string | null,
      applicationSlug: string | null,
    ) => Promise<{ eventType: string; name: string }>,
  ): Promise<void> {
    const environmentId = parseId(environmentValue, 'environment');
    const applicationId = applicationValue === undefined || applicationValue === null || applicationValue === '' ? null : parseId(applicationValue, 'application');
    await this.#database.transaction(async (tx) => {
      const environment = await findEnvironment(tx, environmentId);
      assertMayManage(actor, environment.kind);
      const application = applicationId === null ? null : await findApplication(tx, applicationId);
      const { eventType, name } = await work(tx, environmentId, applicationId, application?.slug ?? null);
      // Only names: values never enter the history.
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType,
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { environmentId, environmentName: environment.name, applicationId, name },
        }),
      ]);
    });
  }
}

/** Production's values belong to the people who run it; Company Admins manage test ones. */
export function assertMayManage(actor: Principal, kind: EnvironmentKind): void {
  const allowed =
    actor.permissions.includes('environment-config:manage') ||
    (kind === 'test' && actor.permissions.includes('test-environment-config:manage'));
  if (!allowed) {
    throw new EnvironmentError(
      'forbidden',
      kind === 'production'
        ? "Only Tech Leads and Operators manage production's variables and secrets."
        : "You can't manage this environment's variables and secrets.",
    );
  }
}

function secretPathOf(environmentId: string, applicationSlug: string | null): string {
  const base = secretsPath(currentCompanyId(), environmentId);
  return applicationSlug === null ? `${base}/shared` : `${base}/apps/${applicationSlug}`;
}

function parseName(value: unknown): string {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    throw new EnvironmentError('invalid', 'Names are capital letters, digits and underscores, such as DATABASE_URL.');
  }
  if (RESERVED_NAMES.has(value)) {
    throw new EnvironmentError('invalid', `${value} is set by the platform.`);
  }
  return value;
}

function parseId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new EnvironmentError('invalid', `The ${what} ID is not valid.`);
  }
  return value;
}

async function findEnvironment(tx: TenantTransaction, id: string): Promise<{ name: string; kind: EnvironmentKind }> {
  const { rows } = await tx.query<{ name: string; kind: EnvironmentKind }>(
    'SELECT name, kind FROM environments.environments WHERE id = $1',
    [id],
  );
  if (rows[0] === undefined) {
    throw new EnvironmentError('not-found', 'This environment does not exist.');
  }
  return rows[0];
}

async function findApplication(tx: TenantTransaction, id: string): Promise<{ slug: string }> {
  const { rows } = await tx.query<{ slug: string }>('SELECT slug FROM catalog.applications WHERE id = $1', [id]);
  if (rows[0] === undefined) {
    throw new EnvironmentError('not-found', 'This application does not exist.');
  }
  return rows[0];
}

async function assertNotSecret(tx: TenantTransaction, environmentId: string, applicationId: string | null, name: string): Promise<void> {
  const { rows } = await tx.query(
    `SELECT 1 FROM environments.secrets
     WHERE environment_id = $1 AND application_id IS NOT DISTINCT FROM $2 AND name = $3`,
    [environmentId, applicationId, name],
  );
  if (rows.length > 0) {
    throw new EnvironmentError('conflict', 'A secret already has this name here.');
  }
}
