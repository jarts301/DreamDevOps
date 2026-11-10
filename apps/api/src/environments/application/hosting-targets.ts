import { randomUUID } from 'node:crypto';
import { createDomainEvent, currentCompanyId, isUuid } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import { hasPermissions, type Principal } from '../../identity-access/domain/access.ts';
import { assertCurrentVersion, normalizeTargetName, parseVersion, type RecordStatus } from '../domain/environment.ts';
import { EnvironmentError } from '../domain/errors.ts';
import type {
  HostingTargetConnectedPayload,
  HostingTargetStatusPayload,
  HostingTargetUpdatedPayload,
} from '../domain/events.ts';
import {
  findProvider,
  HOSTING_PROVIDERS,
  type HostingKind,
  type HostingProvider,
  type HostingSettings,
  LOCAL_PROVIDER,
  parseSettings,
} from '../domain/hosting-providers.ts';
import { authorizeChange } from '../domain/protection.ts';

/** Who may change production, including the targets production runs on. */
export const MANAGE_PRODUCTION = 'environments-production:manage';

export interface ProviderSummary {
  readonly key: string;
  readonly name: string;
  readonly kind: HostingKind | null;
  /** Whether the platform can deploy to it yet. */
  readonly deploys: boolean;
}

/** The name the company's target for this machine gets, unless the company already uses it. */
export const LOCAL_TARGET_NAMES = ['This machine', 'This machine (Docker)'];

export interface HostingTargetsOptions {
  /** Whether this server lets companies run applications on its own Docker. */
  readonly localHosting: boolean;
}

export interface HostingTargetView {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderSummary;
  readonly settings: HostingSettings;
  readonly status: RecordStatus;
  /** Send it back with a change, so nobody overwrites a change they haven't seen. */
  readonly version: number;
  /** How many active environments run on it. */
  readonly environments: number;
  /** How many environments have a version running on it now. */
  readonly running: number;
  /** Whether production environments run on it, which protects it like production. */
  readonly servesProduction: boolean;
  readonly createdAt: string;
  readonly archivedAt: string | null;
}

interface TargetRow {
  id: string;
  name: string;
  provider: string;
  settings: HostingSettings;
  status: RecordStatus;
  version: number;
  created_at: Date;
  archived_at: Date | null;
  environments: number;
  production_environments: number;
  running: number;
}

const SELECT_TARGETS = `
  SELECT t.*,
         (SELECT count(*)::int FROM environments.environments e WHERE e.target_id = t.id AND e.status = 'active') AS environments,
         (SELECT count(*)::int FROM environments.environments e
          WHERE e.target_id = t.id AND e.status = 'active' AND e.production) AS production_environments,
         (SELECT count(*)::int FROM environments.environments e
          JOIN environments.deployments d ON d.id = e.live_deployment_id
          WHERE d.target_id = t.id) AS running
  FROM environments.targets t`;

/**
 * The places a company's environments can run: its cloud accounts and self-hosted
 * servers. Choosing where an environment runs means choosing one of these, and moving it
 * means choosing another.
 */
export class HostingTargets {
  readonly #database: TenantDatabase;
  readonly #options: HostingTargetsOptions;

  constructor(database: TenantDatabase, options: HostingTargetsOptions) {
    this.#database = database;
    this.#options = options;
  }

  /**
   * Every kind of place environments can run, with the settings each needs. This machine
   * is left out when the server doesn't allow running applications on it.
   */
  providers(): readonly HostingProvider[] {
    return HOSTING_PROVIDERS.filter((provider) => provider.key !== LOCAL_PROVIDER || this.#options.localHosting);
  }

  /** The company's targets. Its target for this machine is set up the first time they're listed. */
  async list(statusValue: unknown): Promise<HostingTargetView[]> {
    const status = parseStatus(statusValue);
    return this.#database.transaction(async (tx) => {
      if (this.#options.localHosting) {
        await ensureLocalTarget(tx);
      }
      const { rows } = await tx.query<TargetRow>(`${SELECT_TARGETS} WHERE t.status = $1 ORDER BY lower(t.name)`, [status]);
      return rows.map(toView);
    });
  }

  async connect(actor: Principal, input: { name?: unknown; provider?: unknown; settings?: unknown }): Promise<HostingTargetView> {
    const name = normalizeTargetName(input.name);
    const provider = this.providers().find((candidate) => candidate.key === input.provider);
    if (provider === undefined) {
      throw new EnvironmentError('invalid', 'Choose one of the hosting providers.');
    }
    const settings = parseSettings(provider, input.settings);
    const id = randomUUID();
    return this.#database.transaction(async (tx) => {
      await lockCompanyTargets(tx);
      await assertNameFree(tx, name, null);
      if (provider.key === LOCAL_PROVIDER) {
        await assertNoLocalTarget(tx);
      }
      await tx.query(
        `INSERT INTO environments.targets (id, company_id, name, provider, settings, status, created_by)
         VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
        [id, currentCompanyId(), name, provider.key, JSON.stringify(settings), actor.userId],
      );
      await appendToOutbox(tx, [
        createDomainEvent<'HostingTargetConnected', HostingTargetConnectedPayload>({
          eventType: 'HostingTargetConnected',
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { targetId: id, name, provider: provider.key },
        }),
      ]);
      return toView((await findTarget(tx, id))!);
    });
  }

  /**
   * Renames a target or changes its settings. Its provider stays: moving environments
   * elsewhere means choosing another target for them. A target production runs on is
   * protected like production itself.
   */
  async update(
    actor: Principal,
    idValue: unknown,
    input: { name?: unknown; settings?: unknown; version?: unknown; confirmation?: unknown; reason?: unknown },
  ): Promise<HostingTargetView> {
    const id = parseTargetId(idValue);
    const version = parseVersion(input.version);
    const name = input.name === undefined ? undefined : normalizeTargetName(input.name);
    return this.#database.transaction(async (tx) => {
      const current = await lockTarget(tx, id);
      assertCurrentVersion(version, current.version);
      if (current.status === 'archived') {
        throw new EnvironmentError('conflict', 'Restore the target first.');
      }
      const provider = findProvider(current.provider);
      if (provider === null) {
        throw new EnvironmentError('conflict', "This target's provider is no longer offered, so its settings can't change.");
      }
      const settings = input.settings === undefined ? current.settings : parseSettings(provider, input.settings);
      const renamed = name !== undefined && name !== current.name;
      const settingsChanged = JSON.stringify(sorted(settings)) !== JSON.stringify(sorted(current.settings));
      if (!renamed && !settingsChanged) {
        return toView(current);
      }
      const servesProduction = current.production_environments > 0;
      const reason = authorizeChange({ name: current.name, production: servesProduction }, 'edit-target', {
        canManageProduction: hasPermissions(actor, [MANAGE_PRODUCTION]),
        confirmation: input.confirmation,
        reason: input.reason,
      });
      if (renamed) {
        await lockCompanyTargets(tx);
        await assertNameFree(tx, name, id);
      }
      await tx.query(
        `UPDATE environments.targets SET name = $2, settings = $3, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, name ?? current.name, JSON.stringify(settings)],
      );
      await appendToOutbox(tx, [
        createDomainEvent<'HostingTargetUpdated', HostingTargetUpdatedPayload>({
          eventType: 'HostingTargetUpdated',
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: {
            targetId: id,
            name: name ?? current.name,
            provider: current.provider,
            ...(renamed && { previousName: current.name }),
            settingsChanged,
            servesProduction,
            reason,
          },
        }),
      ]);
      return toView((await findTarget(tx, id))!);
    });
  }

  /** Retires a target. Environments still running on it must move first, so none is left without a place. */
  archive(actor: Principal, idValue: unknown, input: { version?: unknown }): Promise<HostingTargetView> {
    return this.#setStatus(actor, idValue, input, 'archived');
  }

  restore(actor: Principal, idValue: unknown, input: { version?: unknown }): Promise<HostingTargetView> {
    return this.#setStatus(actor, idValue, input, 'active');
  }

  async #setStatus(
    actor: Principal,
    idValue: unknown,
    input: { version?: unknown },
    status: RecordStatus,
  ): Promise<HostingTargetView> {
    const id = parseTargetId(idValue);
    const version = parseVersion(input.version);
    return this.#database.transaction(async (tx) => {
      const current = await lockTarget(tx, id);
      assertCurrentVersion(version, current.version);
      if (current.status === status) {
        return toView(current);
      }
      if (status === 'archived' && current.running > 0) {
        throw new EnvironmentError(
          'conflict',
          `${current.running} environment${current.running === 1 ? ' still runs a version' : 's still run versions'} on this target. Stop ${current.running === 1 ? 'it' : 'them'}, or move ${current.running === 1 ? 'it' : 'them'} to another target, first.`,
        );
      }
      if (status === 'archived' && current.environments > 0) {
        throw new EnvironmentError(
          'conflict',
          `${current.environments} environment${current.environments === 1 ? ' runs' : 's run'} on this target. Move ${current.environments === 1 ? 'it' : 'them'} to another target first.`,
        );
      }
      await tx.query(
        `UPDATE environments.targets
         SET status = $2, archived_at = CASE WHEN $2 = 'archived' THEN now() END, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [id, status],
      );
      await appendToOutbox(tx, [
        createDomainEvent<'HostingTargetArchived' | 'HostingTargetRestored', HostingTargetStatusPayload>({
          eventType: status === 'archived' ? 'HostingTargetArchived' : 'HostingTargetRestored',
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { targetId: id, name: current.name, provider: current.provider },
        }),
      ]);
      return toView((await findTarget(tx, id))!);
    });
  }
}

/**
 * Gives the company its target for this machine, if it never had one. A company that
 * archived it keeps it archived. Safe to repeat, and to run at the same time.
 */
export async function ensureLocalTarget(tx: TenantTransaction): Promise<void> {
  const exists = async () =>
    (await tx.query('SELECT 1 FROM environments.targets WHERE provider = $1', [LOCAL_PROVIDER])).rows.length > 0;
  if (await exists()) {
    return;
  }
  await lockCompanyTargets(tx);
  if (await exists()) {
    return;
  }
  const { rows: taken } = await tx.query<{ name: string }>(
    'SELECT lower(name) AS name FROM environments.targets WHERE lower(name) = ANY($1)',
    [LOCAL_TARGET_NAMES.map((name) => name.toLowerCase())],
  );
  const name = LOCAL_TARGET_NAMES.find((candidate) => !taken.some((row) => row.name === candidate.toLowerCase()));
  if (name === undefined) {
    return;
  }
  const id = randomUUID();
  await tx.query(
    `INSERT INTO environments.targets (id, company_id, name, provider, settings, status, created_by)
     VALUES ($1, $2, $3, $4, '{}', 'active', NULL)`,
    [id, currentCompanyId(), name, LOCAL_PROVIDER],
  );
  await appendToOutbox(tx, [
    createDomainEvent<'HostingTargetConnected', HostingTargetConnectedPayload>({
      eventType: 'HostingTargetConnected',
      companyId: currentCompanyId(),
      actorId: null,
      payload: { targetId: id, name, provider: LOCAL_PROVIDER },
    }),
  ]);
}

/** The company's active target for this machine, which new environments run on unless someone chooses another. */
export async function defaultTarget(tx: TenantTransaction): Promise<{ id: string; provider: string } | null> {
  const { rows } = await tx.query<{ id: string; provider: string }>(
    "SELECT id, provider FROM environments.targets WHERE provider = $1 AND status = 'active' FOR SHARE",
    [LOCAL_PROVIDER],
  );
  return rows[0] ?? null;
}

async function assertNoLocalTarget(tx: TenantTransaction): Promise<void> {
  const { rows } = await tx.query<{ status: RecordStatus }>('SELECT status FROM environments.targets WHERE provider = $1', [
    LOCAL_PROVIDER,
  ]);
  if (rows[0] !== undefined) {
    throw new EnvironmentError(
      'conflict',
      rows[0].status === 'archived'
        ? 'The company already has an archived target for this machine. Restore it instead.'
        : 'The company already has a target for this machine.',
    );
  }
}

/** An active target of the current company, for an environment to run on. */
export async function activeTarget(tx: TenantTransaction, idValue: unknown): Promise<{ id: string; provider: string }> {
  const { rows } = await tx.query<{ id: string; provider: string }>(
    "SELECT id, provider FROM environments.targets WHERE id = $1 AND status = 'active' FOR SHARE",
    [isUuid(idValue) ? idValue : '00000000-0000-0000-0000-000000000000'],
  );
  if (rows[0] === undefined) {
    throw new EnvironmentError('invalid', "Choose one of the company's active hosting targets.");
  }
  return rows[0];
}

export function providerSummary(key: string): ProviderSummary {
  const provider = findProvider(key);
  return { key, name: provider?.name ?? key, kind: provider?.kind ?? null, deploys: provider?.deploys ?? false };
}

function parseTargetId(value: unknown): string {
  if (!isUuid(value)) {
    throw new EnvironmentError('invalid', 'The target ID is not valid.');
  }
  return value;
}

export function parseStatus(value: unknown): RecordStatus {
  const status = value === undefined || value === '' ? 'active' : value;
  if (status !== 'active' && status !== 'archived') {
    throw new EnvironmentError('invalid', 'Choose active or archived.');
  }
  return status;
}

async function findTarget(tx: TenantTransaction, id: string): Promise<TargetRow | null> {
  const { rows } = await tx.query<TargetRow>(`${SELECT_TARGETS} WHERE t.id = $1`, [id]);
  return rows[0] ?? null;
}

/** Row-level security limits this to the current company, so another company's target isn't found. */
async function lockTarget(tx: TenantTransaction, id: string): Promise<TargetRow> {
  await tx.query('SELECT 1 FROM environments.targets WHERE id = $1 FOR UPDATE', [id]);
  const target = await findTarget(tx, id);
  if (target === null) {
    throw new EnvironmentError('not-found', 'This hosting target does not exist.');
  }
  return target;
}

/** One change to the company's target names at a time, so two can't take the same name. */
async function lockCompanyTargets(tx: TenantTransaction): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('environments:targets:' || $1, 0))", [currentCompanyId()]);
}

/** Archived targets keep their names, so a name always points to one target. */
async function assertNameFree(tx: TenantTransaction, name: string, exceptId: string | null): Promise<void> {
  const { rows } = await tx.query<{ status: RecordStatus }>(
    'SELECT status FROM environments.targets WHERE lower(name) = lower($1) AND id <> $2',
    [name, exceptId ?? '00000000-0000-0000-0000-000000000000'],
  );
  if (rows[0] !== undefined) {
    throw new EnvironmentError(
      'conflict',
      rows[0].status === 'archived' ? 'An archived target already has this name.' : 'Another target already has this name.',
    );
  }
}

function sorted(settings: HostingSettings): [string, string | number][] {
  return Object.entries(settings).sort(([left], [right]) => left.localeCompare(right));
}

function toView(row: TargetRow): HostingTargetView {
  return {
    id: row.id,
    name: row.name,
    provider: providerSummary(row.provider),
    settings: row.settings,
    status: row.status,
    version: row.version,
    environments: row.environments,
    running: row.running,
    servesProduction: row.production_environments > 0,
    createdAt: row.created_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
  };
}
