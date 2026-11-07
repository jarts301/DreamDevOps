import { Logger } from '@nestjs/common';
import { type CompanyId, createDomainEvent, currentCompanyId, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { Principal } from '../../identity-access/domain/access.ts';
import { EditionError } from '../domain/errors.ts';
import { type Edition, FEATURES, parseEdition, resolveFeatures } from '../domain/features.ts';
import type { EntitlementProvider, ProviderStatus } from './ports.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  readonly #provider: EntitlementProvider;

  constructor(database: TenantDatabase, provider: EntitlementProvider) {
    this.#database = database;
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
    const companies = await runWithCompany(NO_COMPANY, () =>
      this.#database.transaction(async (tx) => {
        const { rows } = await tx.query<{
          companyId: string;
          companyName: string;
          edition: Edition;
          changedAt: Date | null;
        }>(
          `SELECT c.id AS "companyId", c.name AS "companyName",
                  coalesce(e.edition, 'community') AS edition, e.changed_at AS "changedAt"
           FROM tenancy.companies c
           LEFT JOIN editions.company_editions e ON e.company_id = c.id
           ORDER BY lower(c.name)`,
        );
        return rows.map((row) => ({ ...row, changedAt: row.changedAt?.toISOString() ?? null }));
      }),
    );
    return { provider: await this.#status(), companies };
  }

  /** Moves a company to another edition. The Commercial Edition needs the commercial code installed. */
  async setEdition(actor: Principal, companyIdValue: unknown, editionValue: unknown): Promise<void> {
    if (typeof companyIdValue !== 'string' || !UUID_PATTERN.test(companyIdValue)) {
      throw new EditionError('invalid', 'The company ID is not valid.');
    }
    const edition = parseEdition(editionValue);
    if (edition === 'commercial' && !(await this.#status()).commercialAvailable) {
      throw new EditionError('conflict', 'The Commercial Edition is not installed on this server.');
    }
    const companyId = parseCompanyId(companyIdValue);
    await runWithCompany(companyId, () =>
      this.#database.transaction(async (tx) => {
        const { rows } = await tx.query('SELECT 1 FROM tenancy.companies WHERE id = $1 FOR UPDATE', [companyId]);
        if (rows.length === 0) {
          throw new EditionError('not-found', 'This company does not exist.');
        }
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
