import { randomUUID } from 'node:crypto';
import { createDomainEvent, currentCompanyId, type DomainEvent, isUuid } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { ApplicationCatalog } from '../../catalog/application/application-catalog.ts';
import { hasPermissions, type Principal } from '../../identity-access/domain/access.ts';
import {
  assertCurrentVersion,
  environmentSlug,
  normalizeEnvironmentName,
  parseVersion,
  type RecordStatus,
} from '../domain/environment.ts';
import { EnvironmentError } from '../domain/errors.ts';
import type {
  EnvironmentCreatedPayload,
  EnvironmentPayload,
  EnvironmentProtectionPayload,
  EnvironmentRenamedPayload,
  EnvironmentTargetSwitchedPayload,
} from '../domain/events.ts';
import { assertMayBecomeProduction, deploymentKind } from '../domain/deployment.ts';
import { findProvider } from '../domain/hosting-providers.ts';
import { authorizeChange } from '../domain/protection.ts';
import { insertDeployment } from './deployment-records.ts';
import {
  activeTarget,
  defaultTarget,
  ensureLocalTarget,
  MANAGE_PRODUCTION,
  parseStatus,
  providerSummary,
  type ProviderSummary,
} from './hosting-targets.ts';
import type { HostRuntimes } from './ports.ts';

/** Who may deploy to environments that aren't production, and to production. */
export const DEPLOY_TO_TEST = 'deployments-test:run';
export const DEPLOY_TO_PRODUCTION = 'deployments-production:run';

export interface EnvironmentView {
  readonly id: string;
  readonly applicationId: string;
  readonly name: string;
  /** Fixed at creation. It names the environment's infrastructure. */
  readonly slug: string;
  readonly production: boolean;
  readonly status: RecordStatus;
  /** Send it back with a change, so nobody overwrites a change they haven't seen. */
  readonly version: number;
  /** Where it runs, or null until someone chooses. */
  readonly target: { readonly id: string; readonly name: string; readonly provider: ProviderSummary } | null;
  /** The version running in it now, or null when nothing runs. */
  readonly live: LiveVersion | null;
  /** How many variables and secrets it has. */
  readonly variables: number;
  /**
   * Whether its variables changed since the version that runs now started. They apply
   * the next time a version starts, so deploying again applies them.
   */
  readonly settingsPending: boolean;
  /** The deployment queued or under way, if there is one. */
  readonly deploying: { readonly id: string; readonly kind: string; readonly status: string; readonly version: string | null } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface LiveVersion {
  readonly deploymentId: string;
  /** The build it came from, to deploy it again. */
  readonly buildId: string | null;
  readonly version: string;
  readonly imageKind: string | null;
  readonly productive: boolean;
  readonly address: string | null;
  /** Where it runs. After a move that failed, that's still the previous target. */
  readonly target: { readonly id: string; readonly name: string };
  readonly since: string | null;
}

export interface EnvironmentRow {
  id: string;
  application_id: string;
  name: string;
  slug: string;
  production: boolean;
  status: RecordStatus;
  version: number;
  target_id: string | null;
  target_name: string | null;
  target_provider: string | null;
  live_deployment_id: string | null;
  live_version: string | null;
  live_image_kind: string | null;
  live_productive: boolean | null;
  live_address: string | null;
  live_target_id: string | null;
  live_target_name: string | null;
  live_since: Date | null;
  live_build_id: string | null;
  live_repository: string | null;
  live_digest: string | null;
  live_port: number | null;
  live_settings_revision: number | null;
  settings_revision: number;
  variable_count: number;
  deploying_id: string | null;
  deploying_kind: string | null;
  deploying_status: string | null;
  deploying_version: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

/** What a change to production must come with. */
interface Confirmation {
  readonly version?: unknown;
  readonly confirmation?: unknown;
  readonly reason?: unknown;
}

/** Each environment, with where it runs, what runs in it, and any deployment under way. */
export const SELECT_ENVIRONMENTS = `
  SELECT e.*, t.name AS target_name, t.provider AS target_provider,
         l.version AS live_version, l.image_kind AS live_image_kind, l.productive AS live_productive,
         l.address AS live_address, l.target_id AS live_target_id, lt.name AS live_target_name,
         l.finished_at AS live_since, l.build_id AS live_build_id, l.repository AS live_repository,
         l.digest AS live_digest, l.host_port AS live_port, l.settings_revision AS live_settings_revision,
         (SELECT count(*)::int FROM environments.variables v WHERE v.environment_id = e.id) AS variable_count,
         a.id AS deploying_id, a.kind AS deploying_kind, a.status AS deploying_status, a.version AS deploying_version
  FROM environments.environments e
  LEFT JOIN environments.targets t ON t.id = e.target_id
  LEFT JOIN environments.deployments l ON l.id = e.live_deployment_id
  LEFT JOIN environments.targets lt ON lt.id = l.target_id
  LEFT JOIN environments.deployments a ON a.environment_id = e.id AND a.status IN ('queued', 'running')`;

/**
 * Each application's environments, such as development, staging and production, and
 * where each runs. Production environments are protected from mistakes: changing one
 * needs the permission to manage production, its name typed exactly and a reason, and
 * none can be archived while protected.
 */
export class Environments {
  readonly #database: TenantDatabase;
  readonly #catalog: ApplicationCatalog;
  readonly #runtimes: HostRuntimes;
  readonly #localHosting: boolean;

  constructor(
    database: TenantDatabase,
    catalog: ApplicationCatalog,
    runtimes: HostRuntimes,
    options: { readonly localHosting: boolean },
  ) {
    this.#database = database;
    this.#catalog = catalog;
    this.#runtimes = runtimes;
    this.#localHosting = options.localHosting;
  }

  /** An application's environments, with the non-production ones first. */
  async list(applicationId: unknown, statusValue: unknown): Promise<EnvironmentView[]> {
    const status = parseStatus(statusValue);
    const application = await this.#catalog.get(applicationId);
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<EnvironmentRow>(
        `${SELECT_ENVIRONMENTS} WHERE e.application_id = $1 AND e.status = $2 ORDER BY e.production, lower(e.name)`,
        [application.id, status],
      );
      return rows.map(toView);
    });
  }

  /**
   * Creates an environment. Without a target, it runs on the company's target for this
   * machine. To choose later instead, send targetId: null.
   */
  async create(
    actor: Principal,
    applicationId: unknown,
    input: { name?: unknown; production?: unknown; targetId?: unknown; reason?: unknown },
  ): Promise<EnvironmentView> {
    const name = normalizeEnvironmentName(input.name);
    if (input.production !== undefined && typeof input.production !== 'boolean') {
      throw new EnvironmentError('invalid', 'Say whether the environment is production.');
    }
    const production = input.production === true;
    const reason = authorizeChange({ name, production }, 'create', {
      canManageProduction: mayManageProduction(actor),
      reason: input.reason,
    });
    const application = await this.#catalog.get(applicationId);
    if (application.status === 'archived') {
      throw new EnvironmentError('conflict', 'Restore the application first.');
    }
    const id = randomUUID();
    return this.#database.transaction(async (tx) => {
      // One new environment per application at a time, so two can't take the same name or short name.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('environments:' || $1, 0))", [application.id]);
      await assertNameFree(tx, application.id, name, null);
      const slug = await freeSlug(tx, application.id, name);
      const target = await this.#chosenTarget(tx, input.targetId);
      await tx.query(
        `INSERT INTO environments.environments
           (id, company_id, application_id, name, slug, production, target_id, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)`,
        [id, currentCompanyId(), application.id, name, slug, production, target?.id ?? null, actor.userId],
      );
      const events: DomainEvent[] = [
        createDomainEvent<'EnvironmentCreated', EnvironmentCreatedPayload>({
          eventType: 'EnvironmentCreated',
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: {
            environmentId: id,
            applicationId: application.id,
            applicationName: application.name,
            name,
            slug,
            production,
            targetId: target?.id ?? null,
            provider: target?.provider ?? null,
          },
        }),
      ];
      if (production) {
        events.push(
          protectionEvent('EnvironmentProtected', actor, { id, application_id: application.id, name, slug }, application.name, reason),
        );
      }
      await appendToOutbox(tx, events);
      return toView((await findEnvironment(tx, id))!);
    });
  }

  /**
   * Renames an environment, or moves it to another hosting target, or both. When a
   * version runs in it, moving it deploys that version on the new target, and removes it
   * from the old one once it's healthy there.
   */
  async update(
    actor: Principal,
    idValue: unknown,
    input: Confirmation & { name?: unknown; targetId?: unknown },
  ): Promise<EnvironmentView> {
    const id = parseEnvironmentId(idValue);
    const version = parseVersion(input.version);
    const name = input.name === undefined ? undefined : normalizeEnvironmentName(input.name);
    return this.#database.transaction(async (tx) => {
      const current = await lockEnvironment(tx, id);
      assertCurrentVersion(version, current.version);
      if (current.status === 'archived') {
        throw new EnvironmentError('conflict', 'Restore the environment first.');
      }
      const renamed = name !== undefined && name !== current.name;
      const target =
        input.targetId === undefined
          ? undefined
          : input.targetId === null
            ? null
            : await activeTarget(tx, input.targetId);
      const moved = target !== undefined && (target?.id ?? null) !== current.target_id;
      if (!renamed && !moved) {
        return toView(current);
      }
      const reason = authorizeChange(current, renamed ? 'rename' : 'switch-target', {
        canManageProduction: mayManageProduction(actor),
        confirmation: input.confirmation,
        reason: input.reason,
      });
      if (moved) {
        this.#assertMayMoveWhatRuns(actor, current, target ?? null);
      }
      if (renamed) {
        await assertNameFree(tx, current.application_id, name, id);
      }
      const targetId = moved ? (target?.id ?? null) : current.target_id;
      await tx.query(
        `UPDATE environments.environments
         SET name = $2, target_id = $3, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [id, name ?? current.name, targetId],
      );
      const applicationName = (await this.#catalog.get(current.application_id)).name;
      const base = { ...payloadOf(current, applicationName), name: name ?? current.name };
      const events: DomainEvent[] = [];
      if (renamed) {
        events.push(
          createDomainEvent<'EnvironmentRenamed', EnvironmentRenamedPayload>({
            eventType: 'EnvironmentRenamed',
            companyId: currentCompanyId(),
            actorId: actor.userId,
            payload: { ...base, previousName: current.name, reason },
          }),
        );
      }
      if (moved) {
        events.push(
          createDomainEvent<'EnvironmentTargetSwitched', EnvironmentTargetSwitchedPayload>({
            eventType: 'EnvironmentTargetSwitched',
            companyId: currentCompanyId(),
            actorId: actor.userId,
            payload: {
              ...base,
              targetId,
              provider: target?.provider ?? null,
              previousTargetId: current.target_id,
              previousProvider: current.target_provider,
              reason,
            },
          }),
        );
      }
      await appendToOutbox(tx, events);
      if (moved && target !== null && current.live_deployment_id !== null) {
        await this.#moveWhatRuns(tx, actor, current, applicationName, target, reason);
      }
      return toView((await findEnvironment(tx, id))!);
    });
  }

  /** Marks an environment as production, which protects it from then on. */
  protect(actor: Principal, idValue: unknown, input: Confirmation): Promise<EnvironmentView> {
    return this.#change(actor, idValue, input, 'protect', async (tx, current, reason, applicationName) => {
      if (current.production) {
        return false;
      }
      assertMayBecomeProduction(current, liveImage(current), current.deploying_id !== null);
      await tx.query(
        'UPDATE environments.environments SET production = true, version = version + 1, updated_at = now() WHERE id = $1',
        [current.id],
      );
      await appendToOutbox(tx, [protectionEvent('EnvironmentProtected', actor, current, applicationName, reason)]);
      return true;
    });
  }

  /** Removes production's protection, which needs its name typed and a reason, like any change to it. */
  unprotect(actor: Principal, idValue: unknown, input: Confirmation): Promise<EnvironmentView> {
    return this.#change(actor, idValue, input, 'unprotect', async (tx, current, reason, applicationName) => {
      if (!current.production) {
        return false;
      }
      await tx.query(
        'UPDATE environments.environments SET production = false, version = version + 1, updated_at = now() WHERE id = $1',
        [current.id],
      );
      await appendToOutbox(tx, [protectionEvent('EnvironmentUnprotected', actor, current, applicationName, reason)]);
      return true;
    });
  }

  /** Retires an environment. Nothing is deleted, so it can be restored. Production can't be archived. */
  archive(actor: Principal, idValue: unknown, input: Confirmation): Promise<EnvironmentView> {
    return this.#change(actor, idValue, input, 'archive', (tx, current, _reason, applicationName) =>
      this.#setStatus(tx, actor, current, applicationName, 'archived'),
    );
  }

  restore(actor: Principal, idValue: unknown, input: Confirmation): Promise<EnvironmentView> {
    return this.#change(actor, idValue, input, 'restore', (tx, current, _reason, applicationName) =>
      this.#setStatus(tx, actor, current, applicationName, 'active'),
    );
  }

  /**
   * Runs one change to an environment: locks it, checks nobody changed it meanwhile,
   * and applies the production rules before anything is written.
   */
  async #change(
    actor: Principal,
    idValue: unknown,
    input: Confirmation,
    kind: 'protect' | 'unprotect' | 'archive' | 'restore',
    work: (tx: TenantTransaction, current: EnvironmentRow, reason: string | null, applicationName: string) => Promise<boolean>,
  ): Promise<EnvironmentView> {
    const id = parseEnvironmentId(idValue);
    const version = parseVersion(input.version);
    return this.#database.transaction(async (tx) => {
      const current = await lockEnvironment(tx, id);
      assertCurrentVersion(version, current.version);
      if ((kind === 'protect' || kind === 'unprotect') && current.status === 'archived') {
        throw new EnvironmentError('conflict', 'Restore the environment first.');
      }
      const reason =
        kind === 'restore'
          ? null
          : authorizeChange(current, kind, {
              canManageProduction: mayManageProduction(actor),
              confirmation: input.confirmation,
              reason: input.reason,
            });
      await work(tx, current, reason, (await this.#catalog.get(current.application_id)).name);
      return toView((await findEnvironment(tx, id))!);
    });
  }

  /** The target a new environment runs on: the one chosen, none when asked, or this machine. */
  async #chosenTarget(tx: TenantTransaction, targetId: unknown): Promise<{ id: string; provider: string } | null> {
    if (targetId === null) {
      return null;
    }
    if (targetId !== undefined) {
      return activeTarget(tx, targetId);
    }
    if (this.#localHosting) {
      await ensureLocalTarget(tx);
    }
    return defaultTarget(tx);
  }

  /**
   * Moving an environment waits for any deployment under way. If a version runs in it,
   * moving deploys it on the new target, so it needs the permission to deploy there, and
   * a target the platform can deploy to.
   */
  #assertMayMoveWhatRuns(actor: Principal, current: EnvironmentRow, target: { provider: string } | null): void {
    if (current.deploying_id !== null) {
      throw new EnvironmentError('conflict', `Wait for the deployment to ${current.name} to finish first.`);
    }
    if (current.live_deployment_id === null) {
      return;
    }
    if (!hasPermissions(actor, [current.production ? DEPLOY_TO_PRODUCTION : DEPLOY_TO_TEST])) {
      throw new EnvironmentError(
        'forbidden',
        `${current.name} runs ${current.live_version}, and moving it deploys it again. Only people who deploy to ${current.production ? 'production' : 'it'} can move it.`,
      );
    }
    if (target === null) {
      throw new EnvironmentError('conflict', `${current.name} runs ${current.live_version}. Stop it before leaving it without a target.`);
    }
    const provider = findProvider(target.provider);
    const problem = this.#runtimes.problem({ key: target.provider, name: provider?.name ?? target.provider });
    if (problem !== null) {
      throw new EnvironmentError('conflict', `${current.name} runs ${current.live_version}, so it can only move where it can run. ${problem}`);
    }
  }

  /** Deploys what runs on the environment's new target, which then removes it from the old one. */
  async #moveWhatRuns(
    tx: TenantTransaction,
    actor: Principal,
    current: EnvironmentRow,
    applicationName: string,
    target: { id: string; provider: string },
    reason: string | null,
  ): Promise<void> {
    const image = liveImage(current)!;
    const { rows } = await tx.query<{ name: string }>('SELECT name FROM environments.targets WHERE id = $1', [target.id]);
    await insertDeployment(tx, {
      environment: current,
      applicationName,
      kind: deploymentKind(current.live_target_id, target.id),
      image: {
        buildId: current.live_build_id!,
        version: image.version,
        kind: image.kind,
        productive: image.productive,
        repository: current.live_repository!,
        digest: current.live_digest!,
      },
      version: image.version,
      target: { id: target.id, name: rows[0]!.name, provider: target.provider },
      previousTargetId: current.live_target_id,
      actor,
      reason,
    });
  }

  async #setStatus(
    tx: TenantTransaction,
    actor: Principal,
    current: EnvironmentRow,
    applicationName: string,
    status: RecordStatus,
  ): Promise<boolean> {
    if (current.status === status) {
      return false;
    }
    if (status === 'archived' && (current.live_deployment_id !== null || current.deploying_id !== null)) {
      throw new EnvironmentError(
        'conflict',
        current.deploying_id !== null
          ? `Wait for the deployment to ${current.name} to finish first.`
          : `${current.name} runs ${current.live_version}. Stop it before archiving the environment.`,
      );
    }
    if (status === 'active' && current.target_id !== null) {
      const { rows } = await tx.query("SELECT 1 FROM environments.targets WHERE id = $1 AND status = 'active'", [
        current.target_id,
      ]);
      if (rows.length === 0) {
        throw new EnvironmentError('conflict', 'Its hosting target is archived. Restore the target first.');
      }
    }
    await tx.query(
      `UPDATE environments.environments
       SET status = $2, archived_at = CASE WHEN $2 = 'archived' THEN now() END, version = version + 1, updated_at = now()
       WHERE id = $1`,
      [current.id, status],
    );
    await appendToOutbox(tx, [
      createDomainEvent<'EnvironmentArchived' | 'EnvironmentRestored', EnvironmentPayload>({
        eventType: status === 'archived' ? 'EnvironmentArchived' : 'EnvironmentRestored',
        companyId: currentCompanyId(),
        actorId: actor.userId,
        payload: payloadOf(current, applicationName),
      }),
    ]);
    return true;
  }
}

/** What runs in the environment now, if anything. */
function liveImage(row: EnvironmentRow): { version: string; kind: string; productive: boolean } | null {
  return row.live_deployment_id === null || row.live_version === null
    ? null
    : { version: row.live_version, kind: row.live_image_kind ?? '', productive: row.live_productive === true };
}

function mayManageProduction(actor: Principal): boolean {
  return hasPermissions(actor, [MANAGE_PRODUCTION]);
}

function protectionEvent(
  eventType: 'EnvironmentProtected' | 'EnvironmentUnprotected',
  actor: Principal,
  environment: Pick<EnvironmentRow, 'id' | 'application_id' | 'name' | 'slug'>,
  applicationName: string,
  reason: string | null,
) {
  return createDomainEvent<typeof eventType, EnvironmentProtectionPayload>({
    eventType,
    companyId: currentCompanyId(),
    actorId: actor.userId,
    payload: {
      environmentId: environment.id,
      applicationId: environment.application_id,
      applicationName,
      name: environment.name,
      slug: environment.slug,
      production: eventType === 'EnvironmentProtected',
      reason,
    },
  });
}

function payloadOf(row: EnvironmentRow, applicationName: string): EnvironmentPayload {
  return {
    environmentId: row.id,
    applicationId: row.application_id,
    applicationName,
    name: row.name,
    slug: row.slug,
    production: row.production,
  };
}

export function parseEnvironmentId(value: unknown): string {
  if (!isUuid(value)) {
    throw new EnvironmentError('invalid', 'The environment ID is not valid.');
  }
  return value;
}

export async function findEnvironment(tx: TenantTransaction, id: string): Promise<EnvironmentRow | null> {
  const { rows } = await tx.query<EnvironmentRow>(`${SELECT_ENVIRONMENTS} WHERE e.id = $1`, [id]);
  return rows[0] ?? null;
}

/** Row-level security limits this to the current company, so another company's environment isn't found. */
export async function lockEnvironment(tx: TenantTransaction, id: string): Promise<EnvironmentRow> {
  await tx.query('SELECT 1 FROM environments.environments WHERE id = $1 FOR UPDATE', [id]);
  const environment = await findEnvironment(tx, id);
  if (environment === null) {
    throw new EnvironmentError('not-found', 'This environment does not exist.');
  }
  return environment;
}

/** Archived environments keep their names, so a name always points to one environment. */
async function assertNameFree(tx: TenantTransaction, applicationId: string, name: string, exceptId: string | null) {
  const { rows } = await tx.query<{ status: RecordStatus }>(
    'SELECT status FROM environments.environments WHERE application_id = $1 AND lower(name) = lower($2) AND id <> $3',
    [applicationId, name, exceptId ?? '00000000-0000-0000-0000-000000000000'],
  );
  if (rows[0] !== undefined) {
    throw new EnvironmentError(
      'conflict',
      rows[0].status === 'archived'
        ? 'An archived environment of this application already has this name.'
        : 'This application already has an environment with this name.',
    );
  }
}

async function freeSlug(tx: TenantTransaction, applicationId: string, name: string): Promise<string> {
  for (let number = 1; number <= 100; number += 1) {
    const candidate = environmentSlug(name, number);
    const { rows } = await tx.query('SELECT 1 FROM environments.environments WHERE application_id = $1 AND slug = $2', [
      applicationId,
      candidate,
    ]);
    if (rows.length === 0) {
      return candidate;
    }
  }
  throw new EnvironmentError('conflict', 'Too many environments have a similar name.');
}

export function toView(row: EnvironmentRow): EnvironmentView {
  return {
    id: row.id,
    applicationId: row.application_id,
    name: row.name,
    slug: row.slug,
    production: row.production,
    status: row.status,
    version: row.version,
    target:
      row.target_id === null
        ? null
        : { id: row.target_id, name: row.target_name ?? '', provider: providerSummary(row.target_provider ?? '') },
    live:
      row.live_deployment_id === null || row.live_version === null
        ? null
        : {
            deploymentId: row.live_deployment_id,
            buildId: row.live_build_id,
            version: row.live_version,
            imageKind: row.live_image_kind,
            productive: row.live_productive === true,
            address: row.live_address,
            target: { id: row.live_target_id!, name: row.live_target_name ?? '' },
            since: row.live_since?.toISOString() ?? null,
          },
    variables: row.variable_count,
    // Versions deployed before variables existed started with none, as at revision 0.
    settingsPending: row.live_deployment_id !== null && (row.live_settings_revision ?? 0) < row.settings_revision,
    deploying:
      row.deploying_id === null
        ? null
        : {
            id: row.deploying_id,
            kind: row.deploying_kind ?? 'deploy',
            status: row.deploying_status ?? 'queued',
            version: row.deploying_version,
          },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
  };
}
