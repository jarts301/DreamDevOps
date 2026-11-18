import { RepositoryCreated, RepositoryCreationFailed, RepositoryRequested } from '@dreamdevops/contracts/source-governance/events';
import { currentCompanyId, describeError, parseCompanyId, runWithCompany, withRenewal } from '@dreamdevops/shared-kernel';
import type { BlueprintCatalog } from '@dreamdevops/contracts/blueprints/services';
import { type ApplicationDirectory } from '@dreamdevops/contracts/catalog/services';
import type { Principal } from '@dreamdevops/contracts/identity-access/access';
import type { CompanyDirectory, CompanyRecord } from '@dreamdevops/contracts/tenancy/services';
import { SourceError } from '../domain/errors.ts';
import { GIT_FLOW, WEBHOOK_EVENTS } from '../domain/git-flow.ts';
import {
  PermanentSourceError,
  type RepositorySpec,
  type SourceHost,
  type SourceStore,
  type StoredRepository,
} from './ports.ts';
import type { RepositoryView } from '@dreamdevops/contracts/source-governance/http';
import type { RepositoryLocation, RepositoryLookup } from '@dreamdevops/contracts/source-governance/services';

/**
 * The version of the rules a repository gets. Raise it when the rules change, and
 * repositories made before are brought up to date when the API starts.
 */
export const POLICY_VERSION = 3;

/** How long a job's claim on a repository lasts, unless the job renews it. */
const CLAIM_SECONDS = 120;
/** How often a working job renews its claim, well within the claim's length. */
const RENEW_MS = 30_000;
const NO_COMPANY = parseCompanyId('00000000-0000-0000-0000-000000000000');

/** Another job is creating the same repository. Thrown so this job is tried again later. */
export class RepositoryBusyError extends Error {
  constructor() {
    super('Another job is creating this repository. It will be tried again.');
    this.name = 'RepositoryBusyError';
  }
}

export interface RepositoriesOptions {
  /** Attempts before the repository is marked as failed, so someone can step in. */
  readonly maxAttempts: number;
  /** Forgejo's address in the browser, for links. */
  readonly publicUrl: string;
  /** Where Forgejo sends each repository's events. */
  readonly webhookUrl: string;
  /** Each repository's webhook secret. */
  readonly webhookSecret: (applicationId: string) => string;
}

/**
 * Creates each application's repository from its blueprint, with Git Flow branches and
 * rules. Every step is safe to repeat, so a retry carries on where the last one stopped.
 */
export class Repositories implements RepositoryLookup {
  readonly #store: SourceStore;
  readonly #companies: CompanyDirectory;
  readonly #host: SourceHost;
  readonly #catalog: ApplicationDirectory;
  readonly #blueprints: BlueprintCatalog;
  readonly #options: RepositoriesOptions;

  constructor(
    store: SourceStore,
    companies: CompanyDirectory,
    host: SourceHost,
    catalog: ApplicationDirectory,
    blueprints: BlueprintCatalog,
    options: RepositoriesOptions,
  ) {
    this.#store = store;
    this.#companies = companies;
    this.#host = host;
    this.#catalog = catalog;
    this.#blueprints = blueprints;
    this.#options = options;
  }

  /** The current company's repositories. */
  async list(): Promise<RepositoryView[]> {
    const repositories = await this.#store.transaction((session) => session.list());
    return repositories.map((repository) => this.#toView(repository));
  }

  async find(applicationId: string): Promise<RepositoryLocation | null> {
    return locationOf(await this.#store.transaction((session) => session.find(applicationId)));
  }

  async findByName(organization: string, name: string): Promise<RepositoryLocation | null> {
    return locationOf(await this.#store.transaction((session) => session.findByName(organization, name)));
  }

  /**
   * Asks for a repository to be created, or tried again after it failed. Applications
   * registered before repositories existed need this once.
   */
  async request(actor: Principal, applicationId: unknown): Promise<void> {
    const application = await this.#catalog.get(applicationId);
    if (application.status === 'archived') {
      throw new SourceError('conflict', 'Restore the application first.');
    }
    // Asked before the transaction, so it never waits on another module.
    const company = await this.#currentCompany();
    await this.#store.transaction(async (session) => {
      const repository = await session.lock(application.id);
      if (repository?.status === 'ready') {
        throw new SourceError('conflict', 'This application already has a repository.');
      }
      if (repository?.status === 'creating') {
        return;
      }
      await session.markCreating(application.id, company.slug, application.slug);
      await session.record([
        RepositoryRequested.create({
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { applicationId: application.id },
        }),
      ]);
    });
  }

  /**
   * Runs in the application's company. Throws to have the job tried again later.
   *
   * Git is called with no transaction open. A short one first claims the repository, so two
   * jobs never create it at once, and chooses its blueprint version once, so every try uses
   * the same scaffold. Another records what happened.
   */
  async provision(applicationId: string): Promise<void> {
    // Other modules are asked first, so no transaction waits on them.
    const application = await this.#catalog.get(applicationId);
    const company = await this.#currentCompany();

    const claimed = await this.#store.transaction(async (session) => {
      let repository = await session.lock(applicationId);
      if (repository?.status === 'ready') {
        return null;
      }
      if (repository === null) {
        await session.markCreating(applicationId, company.slug, application.slug);
        repository = (await session.lock(applicationId))!;
      }
      if (!(await session.claim(applicationId, CLAIM_SECONDS))) {
        throw new RepositoryBusyError();
      }
      let blueprint = repository.blueprint;
      if (blueprint === null) {
        // The newest version of the blueprint chosen when the application was registered.
        const newest =
          application.blueprint === null
            ? this.#blueprints.latestForType(application.type.key)
            : this.#blueprints.latestOf(application.blueprint.key);
        if (newest !== null) {
          blueprint = { key: newest.key, version: newest.version };
          await session.chooseBlueprint(applicationId, blueprint);
        }
      }
      return { spec: { organization: repository.organization, name: repository.name, applicationId } satisfies RepositorySpec, blueprint };
    });
    if (claimed === null) {
      return;
    }
    const { spec, blueprint } = claimed;

    let outcome: { repositoryId: string; blueprint: { key: string; version: string } } | { error: unknown };
    try {
      const renew = () => this.#store.transaction((session) => session.renewClaim(applicationId, CLAIM_SECONDS));
      outcome = await withRenewal(renew, { everyMs: RENEW_MS }, async () => {
        if (company.status !== 'active') {
          throw new Error("The company's Git organization isn't ready yet.");
        }
        if (blueprint === null) {
          throw new PermanentSourceError(`No blueprint exists for the ${application.type.name} type.`);
        }
        await this.#host.ensureTeams(spec.organization);
        const repository = await this.#host.ensureRepository(spec);
        if (repository.empty) {
          const files = this.#blueprints.render(blueprint.key, blueprint.version, {
            name: application.name,
            slug: application.slug,
          });
          await this.#host.commitInitialFiles(spec, files, `Start from the ${blueprint.key} ${blueprint.version} blueprint`);
        }
        await this.#applyPolicy(spec);
        if (application.status === 'archived') {
          await this.#host.setArchived(spec, true);
        }
        return { repositoryId: repository.id, blueprint };
      });
    } catch (error) {
      outcome = { error };
    }

    const failure = await this.#store.transaction(async (session) => {
      if ('repositoryId' in outcome) {
        await session.markReady(applicationId, outcome.repositoryId, POLICY_VERSION);
        await session.record([
          RepositoryCreated.create({
            companyId: currentCompanyId(),
            payload: {
              applicationId,
              name: application.name,
              repository: `${spec.organization}/${spec.name}`,
              blueprint: outcome.blueprint.key,
              blueprintVersion: outcome.blueprint.version,
            },
          }),
        ]);
        return null;
      }
      const { error } = outcome;
      const repository = (await session.lock(applicationId))!;
      const reason = describeError(error);
      const attempts = repository.attempts + 1;
      const failed = error instanceof PermanentSourceError || attempts >= this.#options.maxAttempts;
      await session.recordFailure(applicationId, { failed, attempts, error: reason });
      if (failed) {
        await session.record([
          RepositoryCreationFailed.create({
            companyId: currentCompanyId(),
            payload: { applicationId, name: application.name, reason },
          }),
        ]);
        return null;
      }
      return error;
    });

    // Thrown after the transaction commits, so the failed attempt stays recorded.
    if (failure !== null) {
      throw failure;
    }
  }

  /**
   * Brings the current company's repositories made under older rules up to date. Each
   * step is safe to repeat, so a failure leaves the repository to try again later.
   */
  async upgradePolicies(): Promise<void> {
    const outdated = await this.#store.transaction((session) => session.outdated(POLICY_VERSION));
    for (const repository of outdated) {
      const spec = { organization: repository.organization, name: repository.name, applicationId: repository.applicationId };
      await this.#host.ensureTeams(spec.organization);
      await this.#applyPolicy(spec);
      await this.#store.transaction((session) => session.setPolicyVersion(repository.applicationId, POLICY_VERSION));
    }
  }

  /**
   * Brings every company's repositories made under older rules up to date, company by
   * company. A company that fails is reported, and doesn't stop the others.
   */
  async upgradeEveryCompany(onError: (companyId: string, error: unknown) => void): Promise<void> {
    const companies = await runWithCompany(NO_COMPANY, () =>
      this.#store.transaction((session) => session.companiesWithOutdatedRepositories(POLICY_VERSION)),
    );
    for (const companyId of companies) {
      await runWithCompany(parseCompanyId(companyId), () => this.upgradePolicies()).catch((error: unknown) => onError(companyId, error));
    }
  }

  /** The repository's branches, for choosing which to build. */
  async branches(applicationId: unknown): Promise<string[]> {
    const application = await this.#catalog.get(applicationId);
    const repository = await this.#store.transaction((session) => session.lock(application.id));
    if (repository?.status !== 'ready') {
      return [];
    }
    return this.#host.listBranches({ organization: repository.organization, name: repository.name, applicationId: application.id });
  }

  /** Where an application's repository is, for other modules. Null until it's ready. */
  async locate(applicationId: string): Promise<RepositorySpec | null> {
    const found = await this.find(applicationId);
    return found?.status === 'ready' ? { organization: found.organization, name: found.name, applicationId } : null;
  }

  async #applyPolicy(spec: RepositorySpec): Promise<void> {
    // Teams need access first: Forgejo drops approving teams that can't see the repository.
    await this.#host.grantTeams(spec);
    await this.#host.applyGitFlow(spec, GIT_FLOW);
    await this.#host.ensureWebhook(spec, {
      url: this.#options.webhookUrl,
      secret: this.#options.webhookSecret(spec.applicationId),
      events: WEBHOOK_EVENTS,
    });
  }

  /** Makes the repository read-only while its application is archived. */
  async syncArchived(applicationId: string, archived: boolean): Promise<void> {
    const repository = await this.#store.transaction((session) => session.lock(applicationId));
    if (repository?.status !== 'ready') {
      return;
    }
    await this.#host.setArchived({ organization: repository.organization, name: repository.name, applicationId }, archived);
  }

  /** The company the work runs for. Its context is only ever set for a company that exists. */
  async #currentCompany(): Promise<CompanyRecord> {
    return (await this.#companies.find(currentCompanyId()))!;
  }

  #toView(repository: StoredRepository): RepositoryView {
    const fullName = `${repository.organization}/${repository.name}`;
    return {
      applicationId: repository.applicationId,
      status: repository.status,
      fullName,
      url: `${this.#options.publicUrl.replace(/\/$/, '')}/${fullName}`,
      blueprint: repository.blueprint,
      lastError: repository.lastError,
    };
  }
}

/** Where a repository is, for other contexts. */
function locationOf(repository: StoredRepository | null): RepositoryLocation | null {
  return repository === null
    ? null
    : {
        applicationId: repository.applicationId,
        organization: repository.organization,
        name: repository.name,
        status: repository.status,
        blueprint: repository.blueprint,
      };
}
