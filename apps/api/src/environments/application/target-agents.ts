import { type CompanyId, createDomainEvent, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import {
  ACCESS_TOKEN_MINUTES,
  assertionTarget,
  HEARTBEAT_SECONDS,
  keyFingerprint,
  newToken,
  parsePublicKey,
  parseToken,
  parseVersionLabel,
  secretMatches,
  verifyAssertion,
} from '../domain/agent-identity.ts';
import { acceptedImageKinds, type EnvironmentKind } from '../domain/environment.ts';
import { EnvironmentError } from '../domain/errors.ts';
import type { TargetStatus } from './environments.ts';

const NO_COMPANY = parseCompanyId('00000000-0000-0000-0000-000000000000');

export interface TargetAgentsOptions {
  /** Where agents reach the API. Signed assertions name this API's token address. */
  readonly agentApiUrl: string;
  /** A connected target not heard from for this long counts as lost. */
  readonly lostAfterSeconds: number;
}

export interface Registration {
  readonly targetId: string;
  readonly tokenUrl: string;
  readonly heartbeatSeconds: number;
  readonly environment: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly kind: EnvironmentKind;
    readonly acceptedImages: readonly string[];
  };
}

interface TargetRow {
  id: string;
  environment_id: string;
  status: TargetStatus;
  registration_token_hash: string | null;
  registration_expires_at: Date | null;
  public_key: string | null;
  access_token_hash: string | null;
  access_token_expires_at: Date | null;
}

interface EnvironmentRow {
  id: string;
  name: string;
  slug: string;
  kind: EnvironmentKind;
  accepts_feature_images: boolean;
  status: string;
}

/**
 * What agents in targets call. Agents have no session: a registration token proves the
 * first call, a signed assertion with the agent's own key proves each token request, and
 * a short-lived access token proves the rest.
 */
export class TargetAgents {
  readonly #database: TenantDatabase;
  readonly #options: TargetAgentsOptions;

  constructor(database: TenantDatabase, options: TargetAgentsOptions) {
    this.#database = database;
    this.#options = options;
  }

  get tokenUrl(): string {
    return `${this.#options.agentApiUrl}/api/v1/agent/token`;
  }

  /** The agent sends its public key with the one-time registration token. */
  async register(input: {
    registrationToken?: unknown;
    publicKey?: unknown;
    agentVersion?: unknown;
    kubernetesVersion?: unknown;
  }): Promise<Registration> {
    const refused = () => new EnvironmentError('unauthorized', 'This registration token is not valid.');
    const token = parseToken(input.registrationToken);
    if (token === null) {
      throw refused();
    }
    const publicKey = parsePublicKey(input.publicKey);
    const agentVersion = parseVersionLabel(input.agentVersion);
    const kubernetesVersion = parseVersionLabel(input.kubernetesVersion);
    const companyId = await this.#companyOf(token.targetId, refused);

    return runWithCompany(companyId, () =>
      this.#database.transaction(async (tx) => {
        const target = await lockTarget(tx, token.targetId);
        if (
          target === null ||
          target.status !== 'pending' ||
          target.registration_expires_at === null ||
          target.registration_expires_at.getTime() < Date.now() ||
          !secretMatches(token.secret, target.registration_token_hash)
        ) {
          throw refused();
        }
        const environment = await findEnvironment(tx, target.environment_id);
        if (environment.status !== 'active') {
          throw refused();
        }
        await tx.query(
          `UPDATE environments.targets
           SET status = 'connected', registration_token_hash = NULL, registration_expires_at = NULL,
               public_key = $2, agent_version = $3, kubernetes_version = $4,
               registered_at = now(), last_seen_at = now(), updated_at = now()
           WHERE id = $1`,
          [target.id, publicKey, agentVersion, kubernetesVersion],
        );
        await appendToOutbox(tx, [
          createDomainEvent({
            eventType: 'TargetConnected',
            companyId,
            actorId: null,
            payload: {
              environmentId: environment.id,
              environmentName: environment.name,
              targetId: target.id,
              keyFingerprint: keyFingerprint(publicKey),
              reconnected: false,
            },
          }),
        ]);
        return {
          targetId: target.id,
          tokenUrl: this.tokenUrl,
          heartbeatSeconds: HEARTBEAT_SECONDS,
          environment: {
            id: environment.id,
            name: environment.name,
            slug: environment.slug,
            kind: environment.kind,
            acceptedImages: acceptedImageKinds({
              kind: environment.kind,
              acceptsFeatureImages: environment.accepts_feature_images,
            }),
          },
        };
      }),
    );
  }

  /** Swaps a signed assertion for a short-lived access token. Each assertion works once. */
  async issueAccessToken(assertionValue: unknown): Promise<{ accessToken: string; expiresIn: number }> {
    const refused = () => new EnvironmentError('unauthorized', 'This assertion is not valid.');
    const targetId = assertionTarget(assertionValue);
    if (targetId === null) {
      throw refused();
    }
    const companyId = await this.#companyOf(targetId, refused);

    return runWithCompany(companyId, () =>
      this.#database.transaction(async (tx) => {
        const target = await lockTarget(tx, targetId);
        if (target === null || target.public_key === null || (target.status !== 'connected' && target.status !== 'lost')) {
          throw refused();
        }
        const assertion = verifyAssertion(assertionValue, target.public_key, this.tokenUrl);
        await tx.query('DELETE FROM environments.used_assertions WHERE target_id = $1 AND expires_at < now()', [target.id]);
        const { rowCount } = await tx.query(
          `INSERT INTO environments.used_assertions (target_id, company_id, assertion_id, expires_at)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [target.id, companyId, assertion.assertionId, assertion.expiresAt],
        );
        if (rowCount === 0) {
          throw refused();
        }
        const { token, hash } = newToken(target.id);
        await tx.query(
          `UPDATE environments.targets
           SET access_token_hash = $2, access_token_expires_at = now() + make_interval(mins => $3), updated_at = now()
           WHERE id = $1`,
          [target.id, hash, ACCESS_TOKEN_MINUTES],
        );
        await this.#seen(tx, companyId, target);
        return { accessToken: token, expiresIn: ACCESS_TOKEN_MINUTES * 60 };
      }),
    );
  }

  /** The agent reports in. A lost target that reports in is connected again. */
  async heartbeat(
    accessToken: string | undefined,
    input: { agentVersion?: unknown; kubernetesVersion?: unknown },
  ): Promise<{ heartbeatSeconds: number }> {
    const refused = () => new EnvironmentError('unauthorized', 'This access token is not valid.');
    const token = parseToken(accessToken);
    if (token === null) {
      throw refused();
    }
    const agentVersion = parseVersionLabel(input.agentVersion);
    const kubernetesVersion = parseVersionLabel(input.kubernetesVersion);
    const companyId = await this.#companyOf(token.targetId, refused);

    return runWithCompany(companyId, () =>
      this.#database.transaction(async (tx) => {
        const target = await lockTarget(tx, token.targetId);
        if (
          target === null ||
          (target.status !== 'connected' && target.status !== 'lost') ||
          target.access_token_expires_at === null ||
          target.access_token_expires_at.getTime() < Date.now() ||
          !secretMatches(token.secret, target.access_token_hash)
        ) {
          throw refused();
        }
        await tx.query(
          `UPDATE environments.targets
           SET agent_version = coalesce($2, agent_version), kubernetes_version = coalesce($3, kubernetes_version)
           WHERE id = $1`,
          [target.id, agentVersion, kubernetesVersion],
        );
        await this.#seen(tx, companyId, target);
        return { heartbeatSeconds: HEARTBEAT_SECONDS };
      }),
    );
  }

  /** Marks connected targets that stopped reporting as lost, in every company. */
  async markSilentTargetsLost(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - this.#options.lostAfterSeconds * 1000);
    const silent = await runWithCompany(NO_COMPANY, () =>
      this.#database.transaction(async (tx) => {
        const { rows } = await tx.query<{ target_id: string; company_id: string }>(
          'SELECT * FROM environments.silent_targets($1)',
          [cutoff],
        );
        return rows;
      }),
    );
    for (const { target_id: targetId, company_id: company } of silent) {
      const companyId = parseCompanyId(company);
      await runWithCompany(companyId, () =>
        this.#database.transaction(async (tx) => {
          const { rows } = await tx.query<{ environment_id: string; last_seen_at: Date }>(
            `UPDATE environments.targets SET status = 'lost', updated_at = now()
             WHERE id = $1 AND status = 'connected' AND last_seen_at < $2
             RETURNING environment_id, last_seen_at`,
            [targetId, cutoff],
          );
          if (rows[0] === undefined) {
            return;
          }
          const environment = await findEnvironment(tx, rows[0].environment_id);
          await appendToOutbox(tx, [
            createDomainEvent({
              eventType: 'TargetLost',
              companyId,
              actorId: null,
              payload: {
                environmentId: environment.id,
                environmentName: environment.name,
                targetId,
                lastSeenAt: rows[0].last_seen_at.toISOString(),
              },
            }),
          ]);
        }),
      );
    }
  }

  async #seen(tx: TenantTransaction, companyId: CompanyId, target: TargetRow): Promise<void> {
    await tx.query(
      `UPDATE environments.targets SET status = 'connected', last_seen_at = now(), updated_at = now() WHERE id = $1`,
      [target.id],
    );
    if (target.status === 'lost') {
      const environment = await findEnvironment(tx, target.environment_id);
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'TargetConnected',
          companyId,
          actorId: null,
          payload: {
            environmentId: environment.id,
            environmentName: environment.name,
            targetId: target.id,
            keyFingerprint: keyFingerprint(target.public_key!),
            reconnected: true,
          },
        }),
      ]);
    }
  }

  /** Finds a target's company without a company context. Unknown targets get the same refusal as bad tokens. */
  async #companyOf(targetId: string, refused: () => Error): Promise<CompanyId> {
    const company = await runWithCompany(NO_COMPANY, () =>
      this.#database.transaction(async (tx) => {
        const { rows } = await tx.query<{ target_company: string | null }>('SELECT environments.target_company($1)', [
          targetId,
        ]);
        return rows[0]?.target_company ?? null;
      }),
    );
    if (company === null) {
      throw refused();
    }
    return parseCompanyId(company);
  }
}

async function lockTarget(tx: TenantTransaction, id: string): Promise<TargetRow | null> {
  const { rows } = await tx.query<TargetRow>(
    `SELECT id, environment_id, status, registration_token_hash, registration_expires_at, public_key,
            access_token_hash, access_token_expires_at
     FROM environments.targets WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ?? null;
}

async function findEnvironment(tx: TenantTransaction, id: string): Promise<EnvironmentRow> {
  const { rows } = await tx.query<EnvironmentRow>(
    'SELECT id, name, slug, kind, accepts_feature_images, status FROM environments.environments WHERE id = $1',
    [id],
  );
  return rows[0]!;
}
