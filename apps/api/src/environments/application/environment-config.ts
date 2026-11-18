import { createHash, randomUUID } from 'node:crypto';
import {
  EnvironmentSecretRemoved,
  EnvironmentSecretSet,
  EnvironmentVariableRemoved,
  EnvironmentVariableSet,
} from '@dreamdevops/contracts/environments/events';
import { currentCompanyId } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { ApplicationDirectory } from '@dreamdevops/contracts/catalog/services';
import type {
  ConfigScope,
  EnvironmentConfigView,
  ProductionConfirmation,
  SetValue,
} from '@dreamdevops/contracts/environments/http';
import { authorizeChange } from '@dreamdevops/contracts/environments/protection';
import type { EnvironmentValues, ResolvedConfig } from '@dreamdevops/contracts/environments/services';
import type { Unchecked } from '@dreamdevops/contracts/http';
import type { Principal } from '@dreamdevops/contracts/identity-access/access';
import type { EnvironmentKind } from '../domain/environment.ts';
import { EnvironmentError } from '../domain/errors.ts';
import { assertWithinLimits, parseVariableName, parseVariableValue } from '../domain/variables.ts';
import type { SecretStore } from './ports.ts';
import { secretsPath } from './target-configuration.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
export class EnvironmentConfig implements EnvironmentValues {
  readonly #database: TenantDatabase;
  readonly #secrets: SecretStore;
  readonly #applications: ApplicationDirectory;

  constructor(database: TenantDatabase, secrets: SecretStore, applications: ApplicationDirectory) {
    this.#database = database;
    this.#applications = applications;
    this.#secrets = secrets;
  }

  /** The environment's values, or with an application, its values and the environment's. */
  async view(environmentValue: unknown, applicationValue: unknown): Promise<EnvironmentConfigView> {
    const environmentId = parseId(environmentValue, 'environment');
    const applicationId = applicationValue === undefined || applicationValue === '' ? null : parseId(applicationValue, 'application');
    if (applicationId !== null) {
      await this.#applications.get(applicationId);
    }
    return this.#database.transaction(async (tx) => {
      await findEnvironment(tx, environmentId);
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

  async setVariable(actor: Principal, environmentValue: unknown, nameValue: unknown, input: Unchecked<SetValue>): Promise<void> {
    const name = parseVariableName(nameValue);
    const value = parseVariableValue(input.value, { secret: false });
    await this.#change(actor, environmentValue, input.application, input, async (tx, environmentId, applicationId) => {
      await assertNameFree(tx, 'secrets', environmentId, applicationId, name);
      await assertSameCase(tx, 'variables', environmentId, applicationId, name);
      await tx.query(
        `INSERT INTO environments.variables (id, company_id, environment_id, application_id, name, value, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (environment_id, coalesce(application_id, '00000000-0000-0000-0000-000000000000'), upper(name))
         DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
        [randomUUID(), currentCompanyId(), environmentId, applicationId, name, value, actor.userId],
      );
      await assertScopeWithinLimits(tx, environmentId, applicationId);
      return { event: EnvironmentVariableSet, name };
    });
  }

  async removeVariable(
    actor: Principal,
    environmentValue: unknown,
    nameValue: unknown,
    applicationValue: unknown,
    request: Unchecked<ProductionConfirmation> = {},
  ): Promise<void> {
    const name = parseVariableName(nameValue);
    await this.#change(actor, environmentValue, applicationValue, request, async (tx, environmentId, applicationId) => {
      const { rowCount } = await tx.query(
        `DELETE FROM environments.variables
         WHERE environment_id = $1 AND application_id IS NOT DISTINCT FROM $2 AND name = $3`,
        [environmentId, applicationId, name],
      );
      if (rowCount === 0) {
        throw new EnvironmentError('not-found', 'There is no such variable.');
      }
      return { event: EnvironmentVariableRemoved, name };
    });
  }

  /** Saves the value in the secret store, and only the name here. */
  async setSecret(actor: Principal, environmentValue: unknown, nameValue: unknown, input: Unchecked<SetValue>): Promise<void> {
    const name = parseVariableName(nameValue);
    const value = parseVariableValue(input.value, { secret: true });
    await this.#change(actor, environmentValue, input.application, input, async (tx, environmentId, applicationId, application) => {
      await assertNameFree(tx, 'variables', environmentId, applicationId, name);
      await assertSameCase(tx, 'secrets', environmentId, applicationId, name);
      await tx.query(
        `INSERT INTO environments.secrets (id, company_id, environment_id, application_id, name, value_bytes, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (environment_id, coalesce(application_id, '00000000-0000-0000-0000-000000000000'), upper(name))
         DO UPDATE SET value_bytes = excluded.value_bytes, updated_by = excluded.updated_by, updated_at = now()`,
        [randomUUID(), currentCompanyId(), environmentId, applicationId, name, Buffer.byteLength(value, 'utf8'), actor.userId],
      );
      await assertScopeWithinLimits(tx, environmentId, applicationId);
      // Written last, inside the transaction: if the store refuses, the name isn't kept.
      await this.#secrets.write(secretPathOf(environmentId, application), { [name]: value });
      return { event: EnvironmentSecretSet, name };
    });
  }

  async removeSecret(
    actor: Principal,
    environmentValue: unknown,
    nameValue: unknown,
    applicationValue: unknown,
    request: Unchecked<ProductionConfirmation> = {},
  ): Promise<void> {
    const name = parseVariableName(nameValue);
    await this.#change(actor, environmentValue, applicationValue, request, async (tx, environmentId, applicationId, application) => {
      const { rowCount } = await tx.query(
        `DELETE FROM environments.secrets
         WHERE environment_id = $1 AND application_id IS NOT DISTINCT FROM $2 AND name = $3`,
        [environmentId, applicationId, name],
      );
      if (rowCount === 0) {
        throw new EnvironmentError('not-found', 'There is no such secret.');
      }
      await this.#secrets.remove(secretPathOf(environmentId, application), [name]);
      return { event: EnvironmentSecretRemoved, name };
    });
  }

  /**
   * The secret values an application gets in an environment: the environment's, then its
   * own, which win. Only for runtimes the platform drives itself, such as This machine:
   * a cluster's target reads them on its own, with its own token.
   */
  async openSecrets(environmentId: string, applicationSlug: string): Promise<Record<string, string>> {
    const base = secretsPath(currentCompanyId(), environmentId);
    const { token } = await this.#secrets.issueReadToken(`target-${environmentId}`, base);
    return {
      ...(await this.#secrets.read(token, secretPathOf(environmentId, null))),
      ...(await this.#secrets.read(token, secretPathOf(environmentId, applicationSlug))),
    };
  }

  /**
   * A fingerprint of the values an application gets in an environment. It changes whenever
   * one of them is set or removed, so deployments can tell when what runs has older ones.
   */
  fingerprint(environmentId: string, applicationId: string): Promise<string> {
    return this.#database.transaction((tx) => fingerprintIn(tx, environmentId, applicationId));
  }

  /** The fingerprints of several applications' values, in the order asked, in one transaction. */
  fingerprints(places: readonly { readonly environmentId: string; readonly applicationId: string }[]): Promise<string[]> {
    if (places.length === 0) {
      return Promise.resolve([]);
    }
    return this.#database.transaction(async (tx) => {
      const hashes: string[] = [];
      for (const place of places) {
        hashes.push(await fingerprintIn(tx, place.environmentId, place.applicationId));
      }
      return hashes;
    });
  }

  /** The variables an application gets in an environment, and where its secrets are. */
  resolve(environmentId: string, application: { readonly id: string; readonly slug: string }): Promise<ResolvedConfig> {
    return this.#database.transaction((tx) => resolveIn(tx, environmentId, application));
  }

  async #change(
    actor: Principal,
    environmentValue: unknown,
    applicationValue: unknown,
    request: Unchecked<ProductionConfirmation>,
    work: (
      tx: TenantTransaction,
      environmentId: string,
      applicationId: string | null,
      applicationSlug: string | null,
    ) => Promise<{ event: ValueEvent; name: string }>,
  ): Promise<void> {
    const environmentId = parseId(environmentValue, 'environment');
    const applicationId = applicationValue === undefined || applicationValue === null || applicationValue === '' ? null : parseId(applicationValue, 'application');
    const application = applicationId === null ? null : await this.#applications.get(applicationId);
    await this.#database.transaction(async (tx) => {
      const environment = await findEnvironment(tx, environmentId);
      assertMayManage(actor, environment.kind);
      const reason = authorizeChange({ name: environment.name, production: environment.kind === 'production' }, 'change-variables', {
        canManageProduction: actor.permissions.includes('environments-production:manage'),
        confirmation: request.confirmation,
        reason: request.reason,
      });
      const { event, name } = await work(tx, environmentId, applicationId, application?.slug ?? null);
      // Only names: values never enter the history.
      await appendToOutbox(tx, [
        event.create({
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { environmentId, environmentName: environment.name, applicationId, name, ...(reason !== null && { reason }) },
        }),
      ]);
    });
  }
}

/**
 * A fingerprint of the values an application gets in an environment. It changes whenever
 * one of them is set or removed, so deployments can tell when what runs has older ones.
 */
async function fingerprintIn(tx: TenantTransaction, environmentId: string, applicationId: string): Promise<string> {
  const scope = 'environment_id = $1 AND (application_id IS NULL OR application_id = $2) ORDER BY application_id NULLS FIRST, name';
  const { rows: variables } = await tx.query(`SELECT name, value, application_id FROM environments.variables WHERE ${scope}`, [
    environmentId,
    applicationId,
  ]);
  // Secret values aren't here, but every change to one is: it's saved again.
  const { rows: secrets } = await tx.query(
    `SELECT name, application_id, value_bytes, updated_at FROM environments.secrets WHERE ${scope}`,
    [environmentId, applicationId],
  );
  return createHash('sha256').update(JSON.stringify([variables, secrets])).digest('hex');
}

/** The variables an application gets in an environment, and where its secrets are. */
async function resolveIn(
  tx: TenantTransaction,
  environmentId: string,
  application: { readonly id: string; readonly slug: string },
): Promise<ResolvedConfig> {
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

/** What changed about a variable or secret. Only its name is in the event, never its value. */
type ValueEvent = typeof EnvironmentVariableSet | typeof EnvironmentVariableRemoved | typeof EnvironmentSecretSet | typeof EnvironmentSecretRemoved;

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


/** A name is a variable or a secret, never both, in any case. */
async function assertNameFree(
  tx: TenantTransaction,
  other: 'variables' | 'secrets',
  environmentId: string,
  applicationId: string | null,
  name: string,
): Promise<void> {
  const { rows } = await tx.query<{ name: string }>(
    `SELECT name FROM environments.${other}
     WHERE environment_id = $1 AND application_id IS NOT DISTINCT FROM $2 AND upper(name) = upper($3)`,
    [environmentId, applicationId, name],
  );
  if (rows[0] !== undefined) {
    throw new EnvironmentError(
      'conflict',
      `A ${other === 'secrets' ? 'secret' : 'variable'} is already named ${rows[0].name} here. A variable can't become a secret, nor the other way round.`,
    );
  }
}

/** Replacing a value keeps its name: one that differs only in case is another name, which isn't allowed. */
async function assertSameCase(
  tx: TenantTransaction,
  table: 'variables' | 'secrets',
  environmentId: string,
  applicationId: string | null,
  name: string,
): Promise<void> {
  const { rows } = await tx.query<{ name: string }>(
    `SELECT name FROM environments.${table}
     WHERE environment_id = $1 AND application_id IS NOT DISTINCT FROM $2 AND upper(name) = upper($3)`,
    [environmentId, applicationId, name],
  );
  if (rows[0] !== undefined && rows[0].name !== name) {
    throw new EnvironmentError('conflict', `${rows[0].name} is already set here. Names can't differ only in case.`);
  }
}

/** Each scope, the environment's shared values or an application's own, stays within the limits. */
async function assertScopeWithinLimits(tx: TenantTransaction, environmentId: string, applicationId: string | null): Promise<void> {
  const { rows } = await tx.query<{ bytes: number }>(
    `SELECT octet_length(value) AS bytes FROM environments.variables
     WHERE environment_id = $1 AND application_id IS NOT DISTINCT FROM $2
     UNION ALL
     SELECT value_bytes FROM environments.secrets
     WHERE environment_id = $1 AND application_id IS NOT DISTINCT FROM $2`,
    [environmentId, applicationId],
  );
  assertWithinLimits(rows.map((row) => Number(row.bytes)));
}
