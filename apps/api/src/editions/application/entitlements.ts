import { Logger } from '@nestjs/common';
import { type CompanyId, createDomainEvent, currentCompanyId, isUuid, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { Principal } from '../../identity-access/domain/access.ts';
import type { CompanyDirectory } from '../../tenancy/application/company-directory.ts';
import { EditionError } from '../domain/errors.ts';
import { type Edition, FEATURES, parseEdition, resolveFeatures } from '../domain/features.ts';
import type { EntitlementProvider, ProviderStatus } from './ports.ts';

const NO_COMPANY = parseCompanyId('00000000-0000-0000-0000-000000000000');

export interface FeatureView {
  readonly key: string;
  readonly name: string;
  readonly edition: Edition;
  readonly enabled: boolean;
}

export interface CompanyEntitlements {
  readonly edition: Edition;
  readonly features: readonly FeatureView[];
}

export interface CompanyEditionView {
  readonly companyId: string;
  readonly companyName: string;
  readonly edition: Edition;
  readonly changedAt: string | null;
}

/** Says which features each company has, and lets platform admins set each company's edition. */
export class Entitlements {
  readonly #logger = new Logger(Entitlements.name);
  readonly #database: TenantDatabase;
  readonly #companies: CompanyDirectory;
  readonly #provider: EntitlementProvider;

  constructor(database: TenantDatabase, companies: CompanyDirectory, provider: EntitlementProvider) {
    this.#database = database;
    this.#companies = companies;
    this.#provider = provider;
  }

  /** The current company's edition and features. */
  async forCurrentCompany(): Promise<CompanyEntitlements> {
    const companyId = currentCompanyId();
    const edition = await this.#database.transaction((tx) => editionOf(tx, companyId));
    const enabled = await this.#enabled(companyId, edition);
    return {
      edition,
      features: FEATURES.map((feature) => ({ ...feature, enabled: enabled.has(feature.key) })),
    };
  }

  async isEnabled(companyIdValue: string, featureKey: string): Promise<boolean> {
    const companyId = parseCompanyId(companyIdValue);
    const edition = await runWithCompany(companyId, () =>
      this.#database.transaction((tx) => editionOf(tx, companyId)),
    );
    return (await this.#enabled(companyId, edition)).has(featureKey);
  }

  /** Every company's edition, for platform admins. It reveals no company data. */
  async listCompanies(): Promise<{ provider: ProviderStatus; companies: CompanyEditionView[] }> {
    const all = await this.#companies.all();
    const editions = await runWithCompany(NO_COMPANY, () =>
      this.#database.transaction(async (tx) => {
        const { rows } = await tx.query<{ company_id: string; edition: Edition; changed_at: Date }>(
          'SELECT company_id, edition, changed_at FROM editions.company_editions',
        );
        return new Map(rows.map((row) => [row.company_id, row]));
      }),
    );
    // A company without a row is on the Community Edition.
    const companies = all.map((company) => {
      const chosen = editions.get(company.id);
      return {
        companyId: company.id,
        companyName: company.name,
        edition: chosen?.edition ?? 'community',
        changedAt: chosen?.changed_at.toISOString() ?? null,
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
      this.#database.transaction(async (tx) => {
        // One change per company at a time, so the recorded previous edition is always right.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('editions:' || $1, 0))", [companyId]);
        const previous = await editionOf(tx, companyId);
        if (previous === edition) {
          return;
        }
        await tx.query(
          `INSERT INTO editions.company_editions (company_id, edition, changed_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (company_id) DO UPDATE
             SET edition = EXCLUDED.edition, changed_by = EXCLUDED.changed_by, changed_at = now()`,
          [companyId, edition, actor.userId],
        );
        await appendToOutbox(tx, [
          createDomainEvent({
            eventType: 'CompanyEditionChanged',
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

async function editionOf(tx: TenantTransaction, companyId: string): Promise<Edition> {
  const { rows } = await tx.query<{ edition: Edition }>(
    'SELECT edition FROM editions.company_editions WHERE company_id = $1',
    [companyId],
  );
  return rows[0]?.edition ?? 'community';
}
