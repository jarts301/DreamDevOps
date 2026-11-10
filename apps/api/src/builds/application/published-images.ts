import { isUuid } from '@dreamdevops/shared-kernel';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type { SigningKey } from '../domain/signature.ts';
import { type BuildKind, isProductive } from '../domain/versions.ts';
import type { DeployableImage, DeployableImages, SignatureVerification } from './deployable-images.ts';
import type { ImageRegistry } from './ports.ts';
import { checkSignature } from './signature-check.ts';

const LIST_LIMIT = 50;

interface ImageRow {
  id: string;
  application_id: string;
  kind: BuildKind;
  version: string;
  image: string;
  digest: string;
  commit_sha: string;
  finished_at: Date;
}

/** Only builds that went through every step, including signing and verifying, can be deployed. */
const SELECT_IMAGES = `
  SELECT id, application_id, kind, version, image, digest, commit_sha, finished_at
  FROM builds.builds
  WHERE status = 'succeeded' AND digest IS NOT NULL AND image IS NOT NULL`;

/** The images builds published, for deployments. */
export class PublishedImages implements DeployableImages {
  readonly #database: TenantDatabase;
  readonly #registry: ImageRegistry;
  readonly #key: SigningKey;

  constructor(database: TenantDatabase, registry: ImageRegistry, key: SigningKey) {
    this.#database = database;
    this.#registry = registry;
    this.#key = key;
  }

  async list(applicationId: string): Promise<DeployableImage[]> {
    if (!isUuid(applicationId)) {
      return [];
    }
    const { rows } = await this.#database.transaction((tx) =>
      tx.query<ImageRow>(`${SELECT_IMAGES} AND application_id = $1 ORDER BY number DESC LIMIT ${LIST_LIMIT}`, [applicationId]),
    );
    return rows.map(toImage);
  }

  async find(buildId: string): Promise<DeployableImage | null> {
    if (!isUuid(buildId)) {
      return null;
    }
    const { rows } = await this.#database.transaction((tx) => tx.query<ImageRow>(`${SELECT_IMAGES} AND id = $1`, [buildId]));
    return rows[0] === undefined ? null : toImage(rows[0]);
  }

  verify(image: { readonly repository: string; readonly digest: string }): Promise<SignatureVerification> {
    return checkSignature(this.#registry, this.#key, image);
  }
}

function toImage(row: ImageRow): DeployableImage {
  // Images are published as repository:version, so the repository is what's before the tag.
  const tag = `:${row.version}`;
  return {
    buildId: row.id,
    applicationId: row.application_id,
    kind: row.kind,
    version: row.version,
    productive: isProductive(row.kind),
    repository: row.image.endsWith(tag) ? row.image.slice(0, -tag.length) : row.image,
    digest: row.digest,
    commit: row.commit_sha,
    builtAt: row.finished_at.toISOString(),
  };
}
