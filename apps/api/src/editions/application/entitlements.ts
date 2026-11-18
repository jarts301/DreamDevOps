import { CompanyEditionChanged } from '@dreamdevops/contracts/editions/events';
import type { CompanyEntitlements, EditionsOverview } from '@dreamdevops/contracts/editions/http';
import type { FeatureAccess } from '@dreamdevops/contracts/editions/services';
import { type CompanyId, currentCompanyId, isUuid, type Logger, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import type { Principal } from '@dreamdevops/contracts/identity-access/access';
import type { CompanyDirectory } from '@dreamdevops/contracts/tenancy/services';
import { EditionError } from '../domain/errors.ts';
import { type Edition, FEATURES, parseEdition, resolveFeatures } from '../domain/features.ts';
import type { EditionsStore, EntitlementProvider, ProviderStatus } from './ports.ts';

const NO_COMPANY = parseCompanyId('00000000-0000-0000-0000-000000000000');

/** Says which features each company has, and lets platform admins set each company's edition. */
export class Entitlements implements FeatureAccess {
  readonly #store: EditionsStore;
  readonly #companies: CompanyDirectory;
  readonly #provider: EntitlementProvider;
  readonly #logger: Logger;

  constructor(store: EditionsStore, companies: CompanyDirectory, provider: EntitlementProvider, logger: Logger) {
    this.#store = store;
    this.#companies = companies;
    this.#provider = provider;
    this.#logger = logger;
  }

  /** The current company's edition and features. */
  async forCurrentCompany(): Promise<CompanyEntitlements> {
    const companyId = currentCompanyId();
    const edition = await this.#store.transaction((session) => session.editionOf(companyId));
    const enabled = await this.#enabled(companyId, edition);
    return {
      edition,
      features: FEATURES.map((feature) => ({ ...feature, enabled: enabled.has(feature.key) })),
    };
  }

  async isEnabled(companyIdValue: string, featureKey: string): Promise<boolean> {
    const companyId = parseCompanyId(companyIdValue);
    const edition = await runWithCompany(companyId, () => this.#store.transaction((session) => session.editionOf(companyId)));
    return (await this.#enabled(companyId, edition)).has(featureKey);
  }

  /** Every company's edition, for platform admins. It reveals no company data. */
  async listCompanies(): Promise<EditionsOverview> {
    const all = await this.#companies.all();
    const chosen = await runWithCompany(NO_COMPANY, () => this.#store.transaction((session) => session.chosen()));
    const editions = new Map(chosen.map((row) => [row.companyId, row]));
    // A company without a row is on the Community Edition.
    const companies = all.map((company) => {
      const chosen = editions.get(company.id);
      return {
        companyId: company.id,
        companyName: company.name,
        edition: chosen?.edition ?? 'community',
        changedAt: chosen?.changedAt.toISOString() ?? null,
      };
    });
    return { provider: await this.#status(), companies };
  }

  /** Moves a company to another edition. The Commercial Edition needs the commercial code installed. */
  async setEdition(actor: Principal, companyIdValue: unknown, editionValue: unknown): Promise<void> {
    if (!isUuid(companyIdValue)) {
      throw new EditionError('invalid', 'The company ID is not valid.');
    }
    const edition = parseEdition(editionValue);
    if (edition === 'commercial' && !(await this.#status()).commercialAvailable) {
      throw new EditionError('conflict', 'The Commercial Edition is not installed on this server.');
    }
    const companyId = parseCompanyId(companyIdValue);
    if ((await this.#companies.find(companyId)) === null) {
      throw new EditionError('not-found', 'This company does not exist.');
    }
    await runWithCompany(companyId, () =>
      this.#store.transaction(async (session) => {
        // One change per company at a time, so the recorded previous edition is always right.
        await session.lockCompany(companyId);
        const previous = await session.editionOf(companyId);
        if (previous === edition) {
          return;
        }
        await session.setEdition(companyId, edition, actor.userId);
        await session.record([
          CompanyEditionChanged.create({
            companyId,
            actorId: actor.userId,
            payload: { edition, previousEdition: previous, changedBy: actor.userId },
          }),
        ]);
      }),
    );
  }

  /** Asks the provider for commercial features. If it fails, they stay off. */
  async #enabled(companyId: CompanyId, edition: Edition): Promise<ReadonlySet<string>> {
    let fromProvider: ReadonlySet<string> = new Set();
    if (edition === 'commercial') {
      try {
        fromProvider = await this.#provider.commercialFeatures({ companyId, edition });
      } catch (error) {
        this.#logger.error(`The entitlement provider failed, so commercial features are off: ${String(error)}`);
      }
    }
    return resolveFeatures(edition, fromProvider);
  }

  async #status(): Promise<ProviderStatus> {
    try {
      return await this.#provider.status();
    } catch (error) {
      this.#logger.error(`The entitlement provider failed to report its status: ${String(error)}`);
      return { name: 'Unavailable', commercialAvailable: false, detail: 'The license could not be checked.' };
    }
  }
}
