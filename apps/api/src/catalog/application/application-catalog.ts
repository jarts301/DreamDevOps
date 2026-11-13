import { randomUUID } from 'node:crypto';
import { createDomainEvent, currentCompanyId, isUuid } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { BlueprintCatalog } from '../../blueprints/application/blueprint-catalog.ts';
import type { BlueprintManifest } from '../../blueprints/domain/blueprint.ts';
import type { Principal } from '../../identity-access/domain/access.ts';
import {
  type ApplicationStatus,
  applicationSlug,
  normalizeApplicationName,
  normalizeDescription,
} from '../domain/application.ts';
import { CatalogError } from '../domain/errors.ts';
import type { ApplicationRegisteredPayload, ApplicationStatusPayload } from '../domain/events.ts';

/** A blueprint an application can start from: a language and a framework, such as TypeScript and React. */
export interface BlueprintChoice {
  readonly key: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly language: string;
  readonly framework: string;
}

export interface ApplicationType {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** The blueprint new applications of this type start from unless another is chosen. */
  readonly blueprint: BlueprintChoice;
  /** Every blueprint new applications of this type can start from, by language and name. */
  readonly blueprints: readonly BlueprintChoice[];
}

export interface ApplicationView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly type: { readonly key: string; readonly name: string };
  /** The blueprint it started from, chosen when it was registered. */
  readonly blueprint: { readonly key: string; readonly name: string; readonly language: string; readonly framework: string } | null;
  readonly description: string;
  readonly status: ApplicationStatus;
  readonly createdAt: string;
  readonly createdBy: { readonly userId: string; readonly displayName: string | null } | null;
  readonly archivedAt: string | null;
}

interface ApplicationRow {
  id: string;
  name: string;
  slug: string;
  type_key: string;
  type_name: string;
  blueprint_key: string;
  description: string;
  status: ApplicationStatus;
  created_at: Date;
  created_by: string | null;
  creator_name: string | null;
  archived_at: Date | null;
}

/** Reads through a function, because the app's database role can't read user names directly. */
const SELECT_APPLICATIONS = 'SELECT * FROM catalog.applications_view() a';

/** Each company's register of applications. Every query runs in the current company. */
export class ApplicationCatalog {
  readonly #database: TenantDatabase;
  readonly #blueprints: BlueprintCatalog;

  constructor(database: TenantDatabase, blueprints: BlueprintCatalog) {
    this.#database = database;
    this.#blueprints = blueprints;
  }

  /** The types a company can register now: available ones that have a blueprint. */
  async types(): Promise<ApplicationType[]> {
    currentCompanyId();
    const rows = await this.#database.transaction(async (tx) => {
      const { rows: types } = await tx.query<{ key: string; name: string; description: string }>(
        `SELECT key, name, description FROM catalog.application_types
         WHERE available ORDER BY sort_order, name`,
      );
      return types;
    });
    return rows.flatMap((type) => {
      const blueprint = this.#blueprints.latestForType(type.key);
      return blueprint === null
        ? []
        : [{ ...type, blueprint: choiceOf(blueprint), blueprints: this.#blueprints.forType(type.key).map(choiceOf) }];
    });
  }

  async list(statusValue: unknown): Promise<ApplicationView[]> {
    const status = statusValue === undefined || statusValue === '' ? 'active' : statusValue;
    if (status !== 'active' && status !== 'archived') {
      throw new CatalogError('invalid', 'Choose active or archived applications.');
    }
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<ApplicationRow>(
        `${SELECT_APPLICATIONS} WHERE a.status = $1 ORDER BY lower(a.name)`,
        [status],
      );
      return rows.map((row) => this.#toView(row));
    });
  }

  async get(idValue: unknown): Promise<ApplicationView> {
    const id = parseApplicationId(idValue);
    return this.#database.transaction(async (tx) => this.#toView(await findOrFail(tx, id)));
  }

  /**
   * Registers an application of a type, starting from the blueprint chosen for it, such
   * as React in TypeScript for a web frontend, or the type's first blueprint if none is.
   */
  async register(
    actor: Principal,
    input: { name?: unknown; type?: unknown; blueprint?: unknown; description?: unknown },
  ): Promise<ApplicationView> {
    const name = normalizeApplicationName(input.name);
    const description = normalizeDescription(input.description);
    const companyId = currentCompanyId();
    const id = randomUUID();

    return this.#database.transaction(async (tx) => {
      // One registration per company at a time, so two people can't take the same name or short name.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('catalog:' || $1, 0))", [companyId]);
      const type = await availableType(tx, input.type);
      const blueprint = this.#chosenBlueprint(type, input.blueprint);
      await assertNameFree(tx, name, null);
      const slug = await freeSlug(tx, name);
      await tx.query(
        `INSERT INTO catalog.applications (id, company_id, name, slug, type_key, blueprint_key, description, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)`,
        [id, companyId, name, slug, type, blueprint.key, description, actor.userId],
      );
      await appendToOutbox(tx, [
        createDomainEvent<'ApplicationRegistered', ApplicationRegisteredPayload>({
          eventType: 'ApplicationRegistered',
          companyId,
          actorId: actor.userId,
          payload: { applicationId: id, name, slug, type, blueprint: blueprint.key },
        }),
      ]);
      return this.#toView(await findOrFail(tx, id));
    });
  }

  /** The blueprint chosen for a type, or its first one when none is chosen. */
  #chosenBlueprint(type: string, value: unknown): BlueprintManifest {
    if (value === undefined || value === null || value === '') {
      const blueprint = this.#blueprints.latestForType(type);
      if (blueprint === null) {
        throw new CatalogError('invalid', 'Choose one of the available application types.');
      }
      return blueprint;
    }
    const blueprint = this.#blueprints.forType(type).find((candidate) => candidate.key === value);
    if (blueprint === undefined) {
      throw new CatalogError('invalid', 'Choose one of the languages and frameworks this type offers.');
    }
    return blueprint;
  }

  #toView(row: ApplicationRow): ApplicationView {
    const blueprint = this.#blueprints.latestOf(row.blueprint_key);
    return toView(
      row,
      blueprint === null
        ? null
        : { key: blueprint.key, name: blueprint.name, language: blueprint.language, framework: blueprint.framework },
    );
  }

  /** Changes the name or description. The short name stays fixed. */
  update(actor: Principal, idValue: unknown, input: { name?: unknown; description?: unknown }): Promise<void> {
    const id = parseApplicationId(idValue);
    const name = input.name === undefined ? undefined : normalizeApplicationName(input.name);
    const description = input.description === undefined ? undefined : normalizeDescription(input.description);

    return this.#database.transaction(async (tx) => {
      const current = await findOrFail(tx, id, { lock: true });
      if (current.status === 'archived') {
        throw new CatalogError('conflict', 'Restore the application first.');
      }
      const changes: Record<string, string> = {};
      if (name !== undefined && name !== current.name) {
        await assertNameFree(tx, name, id);
        changes.name = name;
        changes.previousName = current.name;
      }
      const descriptionChanged = description !== undefined && description !== current.description;
      if (changes.name === undefined && !descriptionChanged) {
        return;
      }
      await tx.query(
        `UPDATE catalog.applications
         SET name = $2, description = $3, updated_at = now()
         WHERE id = $1`,
        [id, name ?? current.name, description ?? current.description],
      );
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'ApplicationUpdated',
          companyId: currentCompanyId(),
          actorId: actor.userId,
          // The description can be long and isn't needed in the history, so only the fact is kept.
          payload: { applicationId: id, ...changes, descriptionChanged },
        }),
      ]);
    });
  }

  /** Hides the application from the list. Nothing is deleted, so it can be restored. */
  archive(actor: Principal, idValue: unknown): Promise<void> {
    return this.#setStatus(actor, idValue, 'archived');
  }

  restore(actor: Principal, idValue: unknown): Promise<void> {
    return this.#setStatus(actor, idValue, 'active');
  }

  #setStatus(actor: Principal, idValue: unknown, status: ApplicationStatus): Promise<void> {
    const id = parseApplicationId(idValue);
    return this.#database.transaction(async (tx) => {
      const current = await findOrFail(tx, id, { lock: true });
      if (current.status === status) {
        return;
      }
      await tx.query(
        `UPDATE catalog.applications
         SET status = $2, archived_at = CASE WHEN $2 = 'archived' THEN now() END, updated_at = now()
         WHERE id = $1`,
        [id, status],
      );
      await appendToOutbox(tx, [
        createDomainEvent<'ApplicationArchived' | 'ApplicationRestored', ApplicationStatusPayload>({
          eventType: status === 'archived' ? 'ApplicationArchived' : 'ApplicationRestored',
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { applicationId: id, name: current.name },
        }),
      ]);
    });
  }
}

function parseApplicationId(value: unknown): string {
  if (!isUuid(value)) {
    throw new CatalogError('invalid', 'The application ID is not valid.');
  }
  return value;
}

/** Row-level security limits this to the current company, so another company's ID isn't found. */
async function findOrFail(tx: TenantTransaction, id: string, options: { lock?: boolean } = {}): Promise<ApplicationRow> {
  if (options.lock) {
    await tx.query('SELECT 1 FROM catalog.applications WHERE id = $1 FOR UPDATE', [id]);
  }
  const { rows } = await tx.query<ApplicationRow>(`${SELECT_APPLICATIONS} WHERE a.id = $1`, [id]);
  if (rows[0] === undefined) {
    throw new CatalogError('not-found', 'This application does not exist.');
  }
  return rows[0];
}

async function availableType(tx: TenantTransaction, value: unknown): Promise<string> {
  if (typeof value === 'string') {
    const { rows } = await tx.query('SELECT 1 FROM catalog.application_types WHERE key = $1 AND available', [value]);
    if (rows.length > 0) {
      return value;
    }
  }
  throw new CatalogError('invalid', 'Choose one of the available application types.');
}

/** Archived applications keep their names, so a name always points to one application. */
async function assertNameFree(tx: TenantTransaction, name: string, exceptId: string | null): Promise<void> {
  const { rows } = await tx.query<{ status: ApplicationStatus }>(
    'SELECT status FROM catalog.applications WHERE lower(name) = lower($1) AND id <> $2',
    [name, exceptId ?? '00000000-0000-0000-0000-000000000000'],
  );
  if (rows[0] !== undefined) {
    throw new CatalogError(
      'conflict',
      rows[0].status === 'archived'
        ? 'An archived application already has this name.'
        : 'Another application already has this name.',
    );
  }
}

async function freeSlug(tx: TenantTransaction, name: string): Promise<string> {
  for (let number = 1; number <= 100; number += 1) {
    const candidate = applicationSlug(name, number);
    const { rows } = await tx.query('SELECT 1 FROM catalog.applications WHERE slug = $1', [candidate]);
    if (rows.length === 0) {
      return candidate;
    }
  }
  throw new CatalogError('conflict', 'Too many applications have a similar name.');
}

function choiceOf(blueprint: BlueprintManifest): BlueprintChoice {
  return {
    key: blueprint.key,
    version: blueprint.version,
    name: blueprint.name,
    description: blueprint.description,
    language: blueprint.language,
    framework: blueprint.framework,
  };
}

function toView(row: ApplicationRow, blueprint: ApplicationView['blueprint']): ApplicationView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: { key: row.type_key, name: row.type_name },
    blueprint,
    description: row.description,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by === null ? null : { userId: row.created_by, displayName: row.creator_name },
    archivedAt: row.archived_at?.toISOString() ?? null,
  };
}
