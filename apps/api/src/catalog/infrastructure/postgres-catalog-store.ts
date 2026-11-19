import { currentCompanyId } from '@dreamdevops/shared-kernel';
import { PostgresSession, type TenantDatabase, transactional } from '@dreamdevops/shared-kernel/postgres';
import type {
  CatalogSession,
  CatalogStore,
  NewApplication,
  StoredApplication,
  StoredApplicationType,
} from '../application/ports.ts';
import type { ApplicationStatus } from '../domain/application.ts';

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

interface TypeRow {
  key: string;
  name: string;
  description: string;
  default_blueprint: string | null;
}

/** Reads through a function, because the app's database role can't read user names directly. */
const SELECT_APPLICATIONS = 'SELECT * FROM catalog.applications_view() a';
const SELECT_TYPES = 'SELECT key, name, description, default_blueprint FROM catalog.application_types';

/** The catalog's tables. Row-level security limits every query to the current company. */
export function postgresCatalogStore(database: TenantDatabase): CatalogStore {
  return transactional(database, (tx) => new PostgresCatalogSession(tx), { role: 'dreamdevops_catalog' });
}

class PostgresCatalogSession extends PostgresSession implements CatalogSession {
  async availableTypes(): Promise<StoredApplicationType[]> {
    const { rows } = await this.tx.query<TypeRow>(`${SELECT_TYPES} WHERE available ORDER BY sort_order, name`);
    return rows.map(toType);
  }

  async availableType(key: string): Promise<StoredApplicationType | null> {
    const { rows } = await this.tx.query<TypeRow>(`${SELECT_TYPES} WHERE key = $1 AND available`, [key]);
    return rows[0] === undefined ? null : toType(rows[0]);
  }

  async list(status: ApplicationStatus): Promise<StoredApplication[]> {
    const { rows } = await this.tx.query<ApplicationRow>(`${SELECT_APPLICATIONS} WHERE a.status = $1 ORDER BY lower(a.name)`, [
      status,
    ]);
    return rows.map(toApplication);
  }

  async idsBySlug(slugs: readonly string[]): Promise<Map<string, string>> {
    const { rows } = await this.tx.query<{ id: string; slug: string }>('SELECT id, slug FROM catalog.applications WHERE slug = ANY ($1)', [
      slugs,
    ]);
    return new Map(rows.map((row) => [row.slug, row.id]));
  }

  async find(id: string, options: { readonly lock?: boolean } = {}): Promise<StoredApplication | null> {
    if (options.lock) {
      await this.tx.query('SELECT 1 FROM catalog.applications WHERE id = $1 FOR UPDATE', [id]);
    }
    const { rows } = await this.tx.query<ApplicationRow>(`${SELECT_APPLICATIONS} WHERE a.id = $1`, [id]);
    return rows[0] === undefined ? null : toApplication(rows[0]);
  }

  async lockNames(): Promise<void> {
    await this.tx.query("SELECT pg_advisory_xact_lock(hashtextextended('catalog:' || $1, 0))", [currentCompanyId()]);
  }

  async statusOfName(name: string, exceptId: string | null): Promise<ApplicationStatus | null> {
    const { rows } = await this.tx.query<{ status: ApplicationStatus }>(
      'SELECT status FROM catalog.applications WHERE lower(name) = lower($1) AND id <> $2',
      [name, exceptId ?? '00000000-0000-0000-0000-000000000000'],
    );
    return rows[0]?.status ?? null;
  }

  async isSlugTaken(slug: string): Promise<boolean> {
    const { rows } = await this.tx.query('SELECT 1 FROM catalog.applications WHERE slug = $1', [slug]);
    return rows.length > 0;
  }

  async add(application: NewApplication): Promise<void> {
    await this.tx.query(
      `INSERT INTO catalog.applications (id, company_id, name, slug, type_key, blueprint_key, description, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)`,
      [
        application.id,
        currentCompanyId(),
        application.name,
        application.slug,
        application.typeKey,
        application.blueprintKey,
        application.description,
        application.createdBy,
      ],
    );
  }

  async update(id: string, changes: { readonly name: string; readonly description: string }): Promise<void> {
    await this.tx.query(
      `UPDATE catalog.applications
       SET name = $2, description = $3, updated_at = now()
       WHERE id = $1`,
      [id, changes.name, changes.description],
    );
  }

  async setStatus(id: string, status: ApplicationStatus): Promise<void> {
    await this.tx.query(
      `UPDATE catalog.applications
       SET status = $2, archived_at = CASE WHEN $2 = 'archived' THEN now() END, updated_at = now()
       WHERE id = $1`,
      [id, status],
    );
  }
}

function toType(row: TypeRow): StoredApplicationType {
  return { key: row.key, name: row.name, description: row.description, defaultBlueprint: row.default_blueprint };
}

function toApplication(row: ApplicationRow): StoredApplication {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    typeKey: row.type_key,
    typeName: row.type_name,
    blueprintKey: row.blueprint_key,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.created_by,
    creatorName: row.creator_name,
    archivedAt: row.archived_at,
  };
}
