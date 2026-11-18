import type { Registration } from '@dreamdevops/contracts/agent/protocol';
import type { TargetAuthentication } from '@dreamdevops/contracts/environments/services';
import { TargetConnected, TargetLost } from '@dreamdevops/contracts/environments/events';
import { type CompanyId, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import {
  ACCESS_TOKEN_MINUTES,
  assertionTarget,
  HEARTBEAT_SECONDS,
  keyFingerprint,
  newToken,
  parsePublicKey,
  parseToken,
  newTelemetryToken,
  parseVersionLabel,
  secretMatches,
  verifyAssertion,
  verifyTelemetryToken,
} from '../domain/agent-identity.ts';
import { acceptedImageKinds } from '../domain/environment.ts';
import { EnvironmentError } from '../domain/errors.ts';
import type { EnvironmentsSession, EnvironmentsStore, StoredEnvironment, StoredTarget } from './ports.ts';

const NO_COMPANY = parseCompanyId('00000000-0000-0000-0000-000000000000');

export interface TargetAgentsOptions {
  /** Where agents reach the API. Signed assertions name this API's token address. */
  readonly agentApiUrl: string;
  /** A connected target not heard from for this long counts as lost. */
  readonly lostAfterSeconds: number;
  /** The key telemetry tokens are signed with. */
  readonly telemetryKey: string;
}

// What the agent registers with is the agent protocol, kept in the contracts.
export type { Registration } from '@dreamdevops/contracts/agent/protocol';

/**
 * What agents in targets call. Agents have no session: a registration token proves the
 * first call, a signed assertion with the agent's own key proves each token request, and
 * a short-lived access token proves the rest.
 */
export class TargetAgents implements TargetAuthentication {
  readonly #store: EnvironmentsStore;
  readonly #options: TargetAgentsOptions;

  constructor(store: EnvironmentsStore, options: TargetAgentsOptions) {
    this.#store = store;
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
      this.#store.transaction(async (session) => {
        const target = await session.findTarget(token.targetId, { lock: true });
        if (
          target === null ||
          target.status !== 'pending' ||
          target.registrationExpiresAt === null ||
          target.registrationExpiresAt.getTime() < Date.now() ||
          !secretMatches(token.secret, target.registrationTokenHash)
        ) {
          throw refused();
        }
        const environment = await environmentOf(session, target);
        if (environment.status !== 'active') {
          throw refused();
        }
        await session.completeRegistration(target.id, { publicKey, agentVersion, kubernetesVersion });
        await session.record([
          TargetConnected.create({
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
              acceptsFeatureImages: environment.acceptsFeatureImages,
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
      this.#store.transaction(async (session) => {
        const target = await session.findTarget(targetId, { lock: true });
        if (target === null || target.publicKey === null || (target.status !== 'connected' && target.status !== 'lost')) {
          throw refused();
        }
        const assertion = verifyAssertion(assertionValue, target.publicKey, this.tokenUrl);
        if (!(await session.useAssertion(target.id, assertion))) {
          throw refused();
        }
        const { token, hash } = newToken(target.id);
        await session.setAccessToken(target.id, hash, ACCESS_TOKEN_MINUTES);
        await this.#seen(session, companyId, target);
        return { accessToken: token, expiresIn: ACCESS_TOKEN_MINUTES * 60 };
      }),
    );
  }

  /** Checks an agent's access token, and says which target and environment it belongs to. */
  async authenticate(
    accessToken: string | undefined,
  ): Promise<{ companyId: CompanyId; targetId: string; environmentId: string }> {
    const refused = () => new EnvironmentError('unauthorized', 'This access token is not valid.');
    const token = parseToken(accessToken);
    if (token === null) {
      throw refused();
    }
    const companyId = await this.#companyOf(token.targetId, refused);
    const target = await runWithCompany(companyId, () => this.#store.transaction((session) => session.findTarget(token.targetId)));
    if (target === null || !hasValidAccessToken(target, token.secret)) {
      throw refused();
    }
    return { companyId, targetId: target.id, environmentId: target.environmentId };
  }

  /** A token the target's collector sends its telemetry with. */
  issueTelemetryToken(targetId: string): { token: string; expiresAt: Date } {
    return newTelemetryToken(this.#options.telemetryKey, targetId);
  }

  /**
   * Checks a telemetry token, and says which target and environment the telemetry is
   * from. The target must still be connected: disconnecting it stops its telemetry at once.
   */
  async authenticateTelemetry(token: string | undefined): Promise<{ companyId: CompanyId; targetId: string; environmentId: string }> {
    const refused = () => new EnvironmentError('unauthorized', 'This telemetry token is not valid.');
    const targetId = verifyTelemetryToken(this.#options.telemetryKey, token);
    if (targetId === null) {
      throw refused();
    }
    const companyId = await this.#companyOf(targetId, refused);
    const target = await runWithCompany(companyId, () => this.#store.transaction((session) => session.findTarget(targetId)));
    if (target === null || (target.status !== 'connected' && target.status !== 'lost')) {
      throw refused();
    }
    return { companyId, targetId, environmentId: target.environmentId };
  }

  /** The agent reports in. A lost target that reports in is connected again. */
  async heartbeat(
    accessToken: string | undefined,
    input: { agentVersion?: unknown; kubernetesVersion?: unknown },
  ): Promise<{ heartbeatSeconds: number; companyId: CompanyId; targetId: string; environmentId: string }> {
    const refused = () => new EnvironmentError('unauthorized', 'This access token is not valid.');
    const token = parseToken(accessToken);
    if (token === null) {
      throw refused();
    }
    const agentVersion = parseVersionLabel(input.agentVersion);
    const kubernetesVersion = parseVersionLabel(input.kubernetesVersion);
    const companyId = await this.#companyOf(token.targetId, refused);

    return runWithCompany(companyId, () =>
      this.#store.transaction(async (session) => {
        const target = await session.findTarget(token.targetId, { lock: true });
        if (target === null || !hasValidAccessToken(target, token.secret)) {
          throw refused();
        }
        await session.updateVersions(target.id, { agentVersion, kubernetesVersion });
        await this.#seen(session, companyId, target);
        return { heartbeatSeconds: HEARTBEAT_SECONDS, companyId, targetId: target.id, environmentId: target.environmentId };
      }),
    );
  }

  /** Marks connected targets that stopped reporting as lost, in every company. */
  async markSilentTargetsLost(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - this.#options.lostAfterSeconds * 1000);
    const silent = await runWithCompany(NO_COMPANY, () => this.#store.transaction((session) => session.silentTargets(cutoff)));
    for (const { targetId, companyId: company } of silent) {
      const companyId = parseCompanyId(company);
      await runWithCompany(companyId, () =>
        this.#store.transaction(async (session) => {
          const lost = await session.markLostIfSilent(targetId, cutoff);
          if (lost === null) {
            return;
          }
          const environment = (await session.findEnvironment(lost.environmentId))!;
          await session.record([
            TargetLost.create({
              companyId,
              actorId: null,
              payload: {
                environmentId: environment.id,
                environmentName: environment.name,
                targetId,
                lastSeenAt: lost.lastSeenAt.toISOString(),
              },
            }),
          ]);
        }),
      );
    }
  }

  async #seen(session: EnvironmentsSession, companyId: CompanyId, target: StoredTarget): Promise<void> {
    await session.markSeen(target.id);
    if (target.status === 'lost') {
      const environment = await environmentOf(session, target);
      await session.record([
        TargetConnected.create({
          companyId,
          actorId: null,
          payload: {
            environmentId: environment.id,
            environmentName: environment.name,
            targetId: target.id,
            keyFingerprint: keyFingerprint(target.publicKey!),
            reconnected: true,
          },
        }),
      ]);
    }
  }

  /** Finds a target's company without a company context. Unknown targets get the same refusal as bad tokens. */
  async #companyOf(targetId: string, refused: () => Error): Promise<CompanyId> {
    const company = await runWithCompany(NO_COMPANY, () => this.#store.transaction((session) => session.companyOfTarget(targetId)));
    if (company === null) {
      throw refused();
    }
    return parseCompanyId(company);
  }
}

/** Whether a connected, or lost, target's agent holds this access token, still valid. */
function hasValidAccessToken(target: StoredTarget, secret: string): boolean {
  return (
    (target.status === 'connected' || target.status === 'lost') &&
    target.accessTokenExpiresAt !== null &&
    target.accessTokenExpiresAt.getTime() >= Date.now() &&
    secretMatches(secret, target.accessTokenHash)
  );
}

/** A target's environment, which always exists while the target does. */
async function environmentOf(session: EnvironmentsSession, target: StoredTarget): Promise<StoredEnvironment> {
  return (await session.findEnvironment(target.environmentId))!;
}
