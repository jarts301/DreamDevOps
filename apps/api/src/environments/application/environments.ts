import { randomUUID } from 'node:crypto';
import { createDomainEvent, currentCompanyId } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { Principal } from '../../identity-access/domain/access.ts';
import { keyFingerprint, newToken, REGISTRATION_MINUTES } from '../domain/agent-identity.ts';
import {
  acceptedImageKinds,
  acceptsFeatureImages,
  type EnvironmentKind,
  type EnvironmentStatus,
  environmentSlug,
  normalizeEnvironmentName,
  parseKind,
} from '../domain/environment.ts';
import { EnvironmentError } from '../domain/errors.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TargetStatus = 'pending' | 'connected' | 'lost' | 'revoked';

export interface TargetView {
  readonly id: string;
  readonly status: TargetStatus;
  readonly registrationExpiresAt: string | null;
  readonly keyFingerprint: string | null;
  readonly agentVersion: string | null;
  readonly kubernetesVersion: string | null;
  readonly registeredAt: string | null;
  readonly lastSeenAt: string | null;
  readonly createdAt: string;
}

export interface EnvironmentView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly kind: EnvironmentKind;
  readonly acceptsFeatureImages: boolean;
  readonly acceptedImages: readonly string[];
  readonly status: EnvironmentStatus;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  /** The target that runs it, unless none is connected or being connected. */
  readonly target: TargetView | null;
}

export interface Connection {
  readonly targetId: string;
  /** Shown once. Only its hash is stored. */
  readonly registrationToken: string;
  readonly expiresAt: string;
  /** The command to run against the target cluster. */
  readonly command: string;
}

export interface EnvironmentsOptions {
  /** Where agents reach the API. */
  readonly agentApiUrl: string;
  /** The agent's Helm chart. */
  readonly agentChart: string;
}

interface EnvironmentRow {
  id: string;
  name: string;
  slug: string;
  kind: EnvironmentKind;
  accepts_feature_images: boolean;
  status: EnvironmentStatus;
  created_at: Date;
  archived_at: Date | null;
}

interface TargetRow {
  id: string;
  environment_id: string;
  status: TargetStatus;
  registration_expires_at: Date | null;
  public_key: string | null;
  agent_version: string | null;
  kubernetes_version: string | null;
  registered_at: Date | null;
  last_seen_at: Date | null;
  created_at: Date;
}

const TARGET_COLUMNS = `id, environment_id, status, registration_expires_at, public_key, agent_version,
  kubernetes_version, registered_at, last_seen_at, created_at`;

/** Each company's environments and the targets that run them. Every query runs in the current company. */
export class Environments {
  readonly #database: TenantDatabase;
  readonly #options: EnvironmentsOptions;

  constructor(database: TenantDatabase, options: EnvironmentsOptions) {
    this.#database = database;
    this.#options = options;
  }

  async list(statusValue: unknown): Promise<EnvironmentView[]> {
    const status = statusValue === undefined || statusValue === '' ? 'active' : statusValue;
    if (status !== 'active' && status !== 'archived') {
      throw new EnvironmentError('invalid', 'Choose active or archived environments.');
    }
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<EnvironmentRow>(
        `SELECT * FROM environments.environments WHERE status = $1
         ORDER BY kind = 'production' DESC, lower(name)`,
        [status],
      );
      const { rows: targets } = await tx.query<TargetRow>(
        `SELECT ${TARGET_COLUMNS} FROM environments.targets WHERE status <> 'revoked'`,
      );
      const byEnvironment = new Map(targets.map((target) => [target.environment_id, target]));
      return rows.map((row) => toView(row, byEnvironment.get(row.id) ?? null));
    });
  }

  async get(idValue: unknown): Promise<EnvironmentView> {
    const id = parseId(idValue, 'environment');
    return this.#database.transaction(async (tx) => {
      const environment = await findOrFail(tx, id);
      return toView(environment, await currentTarget(tx, id));
    });
  }

  async create(
    actor: Principal,
    input: { name?: unknown; kind?: unknown; acceptsFeatureImages?: unknown },
  ): Promise<EnvironmentView> {
    const name = normalizeEnvironmentName(input.name);
    const kind = parseKind(input.kind);
    const featureImages = acceptsFeatureImages(kind, input.acceptsFeatureImages);
    const companyId = currentCompanyId();
    const id = randomUUID();

    return this.#database.transaction(async (tx) => {
      // One at a time per company, so two people can't take the same name or short name.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('environments:' || $1, 0))", [companyId]);
      await assertNameFree(tx, name, null);
      const slug = await freeSlug(tx, name);
      await tx.query(
        `INSERT INTO environments.environments
           (id, company_id, name, slug, kind, accepts_feature_images, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`,
        [id, companyId, name, slug, kind, featureImages, actor.userId],
      );
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'EnvironmentCreated',
          companyId,
          actorId: actor.userId,
          payload: { environmentId: id, name, slug, kind, acceptsFeatureImages: featureImages },
        }),
      ]);
      return toView(await findOrFail(tx, id), null);
    });
  }

  /** Changes the name, or whether a test environment accepts feature images. The kind stays fixed. */
  update(actor: Principal, idValue: unknown, input: { name?: unknown; acceptsFeatureImages?: unknown }): Promise<void> {
    const id = parseId(idValue, 'environment');
    const name = input.name === undefined ? undefined : normalizeEnvironmentName(input.name);
    return this.#database.transaction(async (tx) => {
      const current = await findOrFail(tx, id, { lock: true });
      if (current.status === 'archived') {
        throw new EnvironmentError('conflict', 'Restore the environment first.');
      }
      const featureImages =
        input.acceptsFeatureImages === undefined
          ? current.accepts_feature_images
          : acceptsFeatureImages(current.kind, input.acceptsFeatureImages);
      const changes: Record<string, unknown> = {};
      if (name !== undefined && name !== current.name) {
        await assertNameFree(tx, name, id);
        changes.name = name;
        changes.previousName = current.name;
      }
      if (featureImages !== current.accepts_feature_images) {
        changes.acceptsFeatureImages = featureImages;
      }
      if (Object.keys(changes).length === 0) {
        return;
      }
      await tx.query(
        `UPDATE environments.environments SET name = $2, accepts_feature_images = $3, updated_at = now() WHERE id = $1`,
        [id, name ?? current.name, featureImages],
      );
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'EnvironmentUpdated',
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { environmentId: id, ...changes },
        }),
      ]);
    });
  }

  /** Hides the environment. It must have no target, so nothing keeps running unseen. */
  archive(actor: Principal, idValue: unknown): Promise<void> {
    return this.#setStatus(actor, idValue, 'archived');
  }

  restore(actor: Principal, idValue: unknown): Promise<void> {
    return this.#setStatus(actor, idValue, 'active');
  }

  #setStatus(actor: Principal, idValue: unknown, status: EnvironmentStatus): Promise<void> {
    const id = parseId(idValue, 'environment');
    return this.#database.transaction(async (tx) => {
      const current = await findOrFail(tx, id, { lock: true });
      if (current.status === status) {
        return;
      }
      if (status === 'archived' && (await currentTarget(tx, id)) !== null) {
        throw new EnvironmentError('conflict', 'Disconnect its target first.');
      }
      await tx.query(
        `UPDATE environments.environments
         SET status = $2, archived_at = CASE WHEN $2 = 'archived' THEN now() END, updated_at = now()
         WHERE id = $1`,
        [id, status],
      );
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: status === 'archived' ? 'EnvironmentArchived' : 'EnvironmentRestored',
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { environmentId: id, name: current.name },
        }),
      ]);
    });
  }

  /**
   * Starts connecting a target: makes a one-time registration token and the Helm command
   * that installs the agent with it. A new token replaces one not used yet.
   */
  connect(actor: Principal, idValue: unknown): Promise<Connection> {
    const id = parseId(idValue, 'environment');
    const companyId = currentCompanyId();
    return this.#database.transaction(async (tx) => {
      const environment = await findOrFail(tx, id, { lock: true });
      if (environment.status === 'archived') {
        throw new EnvironmentError('conflict', 'Restore the environment first.');
      }
      const existing = await currentTarget(tx, id);
      if (existing !== null && existing.status !== 'pending') {
        throw new EnvironmentError('conflict', 'This environment already has a target. Disconnect it first.');
      }
      if (existing !== null) {
        await tx.query(
          `UPDATE environments.targets
           SET status = 'revoked', registration_token_hash = NULL, revoked_at = now(), revoked_by = $2, updated_at = now()
           WHERE id = $1`,
          [existing.id, actor.userId],
        );
      }
      const targetId = randomUUID();
      const { token, hash } = newToken(targetId);
      const { rows } = await tx.query<{ registration_expires_at: Date }>(
        `INSERT INTO environments.targets
           (id, company_id, environment_id, status, registration_token_hash, registration_expires_at, created_by)
         VALUES ($1, $2, $3, 'pending', $4, now() + make_interval(mins => $5), $6)
         RETURNING registration_expires_at`,
        [targetId, companyId, id, hash, REGISTRATION_MINUTES, actor.userId],
      );
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'TargetRegistrationStarted',
          companyId,
          actorId: actor.userId,
          payload: { environmentId: id, environmentName: environment.name, targetId },
        }),
      ]);
      return {
        targetId,
        registrationToken: token,
        expiresAt: rows[0]!.registration_expires_at.toISOString(),
        command: this.#command(token),
      };
    });
  }

  /** Cuts the target off: its key and tokens stop working at once, and a new one can connect. */
  disconnect(actor: Principal, idValue: unknown): Promise<void> {
    const id = parseId(idValue, 'environment');
    return this.#database.transaction(async (tx) => {
      const environment = await findOrFail(tx, id, { lock: true });
      const target = await currentTarget(tx, id);
      if (target === null) {
        throw new EnvironmentError('conflict', 'This environment has no target.');
      }
      await tx.query(
        `UPDATE environments.targets
         SET status = 'revoked', registration_token_hash = NULL, access_token_hash = NULL,
             access_token_expires_at = NULL, revoked_at = now(), revoked_by = $2, updated_at = now()
         WHERE id = $1`,
        [target.id, actor.userId],
      );
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'TargetRevoked',
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: {
            environmentId: id,
            environmentName: environment.name,
            targetId: target.id,
            wasConnected: target.status !== 'pending',
          },
        }),
      ]);
    });
  }

  /**
   * The agent installs into its own namespace and only calls out. The token is passed as
   * a value, which the chart keeps in a Secret; it works once and expires within the hour.
   */
  #command(token: string): string {
    return [
      `helm upgrade --install dreamdevops-agent ${this.#options.agentChart}`,
      '--namespace dreamdevops-system --create-namespace',
      `--set platformUrl=${this.#options.agentApiUrl}`,
      `--set registrationToken=${token}`,
    ].join(' \\\n  ');
  }
}

function parseId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new EnvironmentError('invalid', `The ${what} ID is not valid.`);
  }
  return value;
}

/** Row-level security limits this to the current company, so another company's ID isn't found. */
async function findOrFail(tx: TenantTransaction, id: string, options: { lock?: boolean } = {}): Promise<EnvironmentRow> {
  const { rows } = await tx.query<EnvironmentRow>(
    `SELECT * FROM environments.environments WHERE id = $1${options.lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  if (rows[0] === undefined) {
    throw new EnvironmentError('not-found', 'This environment does not exist.');
  }
  return rows[0];
}

async function currentTarget(tx: TenantTransaction, environmentId: string): Promise<TargetRow | null> {
  const { rows } = await tx.query<TargetRow>(
    `SELECT ${TARGET_COLUMNS} FROM environments.targets WHERE environment_id = $1 AND status <> 'revoked'`,
    [environmentId],
  );
  return rows[0] ?? null;
}

/** Archived environments keep their names, so a name always points to one environment. */
async function assertNameFree(tx: TenantTransaction, name: string, exceptId: string | null): Promise<void> {
  const { rows } = await tx.query<{ status: EnvironmentStatus }>(
    'SELECT status FROM environments.environments WHERE lower(name) = lower($1) AND id <> $2',
    [name, exceptId ?? '00000000-0000-0000-0000-000000000000'],
  );
  if (rows[0] !== undefined) {
    throw new EnvironmentError(
      'conflict',
      rows[0].status === 'archived'
        ? 'An archived environment already has this name.'
        : 'Another environment already has this name.',
    );
  }
}

async function freeSlug(tx: TenantTransaction, name: string): Promise<string> {
  for (let number = 1; number <= 100; number += 1) {
    const candidate = environmentSlug(name, number);
    const { rows } = await tx.query('SELECT 1 FROM environments.environments WHERE slug = $1', [candidate]);
    if (rows.length === 0) {
      return candidate;
    }
  }
  throw new EnvironmentError('conflict', 'Too many environments have a similar name.');
}

function toView(row: EnvironmentRow, target: TargetRow | null): EnvironmentView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    acceptsFeatureImages: row.accepts_feature_images,
    acceptedImages: acceptedImageKinds({ kind: row.kind, acceptsFeatureImages: row.accepts_feature_images }),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
    target: target === null ? null : toTargetView(target),
  };
}

function toTargetView(row: TargetRow): TargetView {
  return {
    id: row.id,
    status: row.status,
    registrationExpiresAt: row.status === 'pending' ? (row.registration_expires_at?.toISOString() ?? null) : null,
    keyFingerprint: row.public_key === null ? null : keyFingerprint(row.public_key),
    agentVersion: row.agent_version,
    kubernetesVersion: row.kubernetes_version,
    registeredAt: row.registered_at?.toISOString() ?? null,
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}
