import { randomUUID } from 'node:crypto';
import { ApplicationArchived, ApplicationRegistered, ApplicationRestored, ApplicationUpdated } from '@dreamdevops/contracts/catalog/events';
import { currentCompanyId, isUuid } from '@dreamdevops/shared-kernel';
import type { BlueprintCatalog, BlueprintManifest } from '@dreamdevops/contracts/blueprints/services';
import type {
  ApplicationType,
  ApplicationView,
  BlueprintChoice,
  RegisterApplication,
  UpdateApplication,
} from '@dreamdevops/contracts/catalog/http';
import type { Unchecked } from '@dreamdevops/contracts/http';
import type { ApplicationDirectory } from '@dreamdevops/contracts/catalog/services';
import type { Principal } from '@dreamdevops/contracts/identity-access/access';
import {
  type ApplicationStatus,
  applicationSlug,
  MAX_SLUG_LENGTH,
  normalizeApplicationName,
  normalizeDescription,
} from '../domain/application.ts';
import { CatalogError } from '../domain/errors.ts';
import type { CatalogSession, CatalogStore, StoredApplication } from './ports.ts';

/** Each company's register of applications. Every query runs in the current company. */
export class ApplicationCatalog implements ApplicationDirectory {
  readonly #store: CatalogStore;
  readonly #blueprints: BlueprintCatalog;

  constructor(store: CatalogStore, blueprints: BlueprintCatalog) {
    this.#store = store;
    this.#blueprints = blueprints;
  }

  /** The types a company can register now: available ones that have a blueprint. */
  async types(): Promise<ApplicationType[]> {
    currentCompanyId();
    const types = await this.#store.transaction((session) => session.availableTypes());
    return types.flatMap(({ defaultBlueprint: defaultKey, ...type }) => {
      const blueprint = this.#defaultBlueprint(type.key, defaultKey);
      return blueprint === null
        ? []
        : [{ ...type, blueprint: choiceOf(blueprint), blueprints: this.#blueprints.forType(type.key).map(choiceOf) }];
    });
  }

  /**
   * The blueprint a type starts from when none is chosen: the one the type names, or, for
   * a type that names none, its first by key.
   */
  #defaultBlueprint(type: string, defaultKey: string | null): BlueprintManifest | null {
    return (
      this.#blueprints.forType(type).find((blueprint) => blueprint.key === defaultKey) ?? this.#blueprints.latestForType(type)
    );
  }

  async list(statusValue: unknown): Promise<ApplicationView[]> {
    const status = statusValue === undefined || statusValue === '' ? 'active' : statusValue;
    if (status !== 'active' && status !== 'archived') {
      throw new CatalogError('invalid', 'Choose active or archived applications.');
    }
    const applications = await this.#store.transaction((session) => session.list(status));
    return applications.map((application) => this.#toView(application));
  }

  /**
   * The current company's applications with these short names, active or archived, as IDs
   * by short name. Names the company doesn't have are left out. For the telemetry gateway,
   * which finds an application by the namespace it runs in, for every batch it's sent.
   */
  async idsBySlug(slugs: readonly string[]): Promise<Map<string, string>> {
    const wanted = [...new Set(slugs)].filter((slug) => slug.length > 0 && slug.length <= MAX_SLUG_LENGTH);
    if (wanted.length === 0) {
      return new Map();
    }
    return this.#store.transaction((session) => session.idsBySlug(wanted));
  }

  async get(idValue: unknown): Promise<ApplicationView> {
    const id = parseApplicationId(idValue);
    return this.#toView(await this.#store.transaction((session) => findOrFail(session, id)));
  }

  /**
   * Registers an application of a type, starting from the blueprint chosen for it, such
   * as React in TypeScript for a web frontend, or the type's first blueprint if none is.
   */
  async register(
    actor: Principal,
    input: Unchecked<RegisterApplication>,
  ): Promise<ApplicationView> {
    const name = normalizeApplicationName(input.name);
    const description = normalizeDescription(input.description);
    const companyId = currentCompanyId();
    const id = randomUUID();

    const registered = await this.#store.transaction(async (session) => {
      // One registration per company at a time, so two people can't take the same name or short name.
      await session.lockNames();
      const type = await availableType(session, input.type);
      const blueprint = this.#chosenBlueprint(type.key, type.defaultBlueprint, input.blueprint);
      await assertNameFree(session, name, null);
      const slug = await freeSlug(session, name);
      await session.add({ id, name, slug, typeKey: type.key, blueprintKey: blueprint.key, description, createdBy: actor.userId });
      await session.record([
        ApplicationRegistered.create({
          companyId,
          actorId: actor.userId,
          payload: { applicationId: id, name, slug, type: type.key, blueprint: blueprint.key },
        }),
      ]);
      return findOrFail(session, id);
    });
    return this.#toView(registered);
  }

  /** The blueprint chosen for a type, or its default when none is chosen. */
  #chosenBlueprint(type: string, defaultKey: string | null, value: unknown): BlueprintManifest {
    if (value === undefined || value === null || value === '') {
      const blueprint = this.#defaultBlueprint(type, defaultKey);
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

  #toView(application: StoredApplication): ApplicationView {
    const blueprint = this.#blueprints.latestOf(application.blueprintKey);
    return toView(
      application,
      blueprint === null
        ? null
        : { key: blueprint.key, name: blueprint.name, language: blueprint.language, framework: blueprint.framework },
    );
  }

  /** Changes the name or description. The short name stays fixed. */
  update(actor: Principal, idValue: unknown, input: Unchecked<UpdateApplication>): Promise<void> {
    const id = parseApplicationId(idValue);
    const name = input.name === undefined ? undefined : normalizeApplicationName(input.name);
    const description = input.description === undefined ? undefined : normalizeDescription(input.description);

    return this.#store.transaction(async (session) => {
      if (name !== undefined) {
        // The lock registering takes, so a rename and a registration can't take the same name at once.
        await session.lockNames();
      }
      const current = await findOrFail(session, id, { lock: true });
      if (current.status === 'archived') {
        throw new CatalogError('conflict', 'Restore the application first.');
      }
      const renamed = name !== undefined && name !== current.name;
      if (renamed) {
        await assertNameFree(session, name, id);
      }
      const descriptionChanged = description !== undefined && description !== current.description;
      if (!renamed && !descriptionChanged) {
        return;
      }
      await session.update(id, { name: name ?? current.name, description: description ?? current.description });
      await session.record([
        ApplicationUpdated.create({
          companyId: currentCompanyId(),
          actorId: actor.userId,
          // The description can be long and isn't needed in the history, so only the fact is kept.
          payload: { applicationId: id, ...(renamed && { name, previousName: current.name }), descriptionChanged },
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
    return this.#store.transaction(async (session) => {
      const current = await findOrFail(session, id, { lock: true });
      if (current.status === status) {
        return;
      }
      await session.setStatus(id, status);
      await session.record([
        (status === 'archived' ? ApplicationArchived : ApplicationRestored).create({
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

/** Another company's application is never found, so its ID gets the same answer as a made-up one. */
async function findOrFail(session: CatalogSession, id: string, options: { lock?: boolean } = {}): Promise<StoredApplication> {
  const application = await session.find(id, options);
  if (application === null) {
    throw new CatalogError('not-found', 'This application does not exist.');
  }
  return application;
}

async function availableType(session: CatalogSession, value: unknown): Promise<{ key: string; defaultBlueprint: string | null }> {
  const type = typeof value === 'string' ? await session.availableType(value) : null;
  if (type === null) {
    throw new CatalogError('invalid', 'Choose one of the available application types.');
  }
  return { key: type.key, defaultBlueprint: type.defaultBlueprint };
}

/** Archived applications keep their names, so a name always points to one application. */
async function assertNameFree(session: CatalogSession, name: string, exceptId: string | null): Promise<void> {
  const status = await session.statusOfName(name, exceptId);
  if (status !== null) {
    throw new CatalogError(
      'conflict',
      status === 'archived' ? 'An archived application already has this name.' : 'Another application already has this name.',
    );
  }
}

async function freeSlug(session: CatalogSession, name: string): Promise<string> {
  for (let number = 1; number <= 100; number += 1) {
    const candidate = applicationSlug(name, number);
    if (!(await session.isSlugTaken(candidate))) {
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

function toView(application: StoredApplication, blueprint: ApplicationView['blueprint']): ApplicationView {
  return {
    id: application.id,
    name: application.name,
    slug: application.slug,
    type: { key: application.typeKey, name: application.typeName },
    blueprint,
    description: application.description,
    status: application.status,
    createdAt: application.createdAt.toISOString(),
    createdBy: application.createdBy === null ? null : { userId: application.createdBy, displayName: application.creatorName },
    archivedAt: application.archivedAt?.toISOString() ?? null,
  };
}
