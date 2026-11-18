import { randomUUID } from 'node:crypto';
import {
  EnvironmentArchived,
  EnvironmentCreated,
  EnvironmentRestored,
  EnvironmentUpdated,
  TargetConnected,
  TargetRegistrationStarted,
  TargetRevoked,
} from '@dreamdevops/contracts/environments/events';
import type {
  Connection,
  ConnectTarget,
  CreateEnvironment,
  EnvironmentView,
  ProductionConfirmation,
  ProviderView,
  TargetView,
  UpdateEnvironment,
} from '@dreamdevops/contracts/environments/http';
import { authorizeChange, type ProtectedChange } from '@dreamdevops/contracts/environments/protection';
import type { EnvironmentDirectory } from '@dreamdevops/contracts/environments/services';
import type { Unchecked } from '@dreamdevops/contracts/http';
import type { Principal } from '@dreamdevops/contracts/identity-access/access';
import { currentCompanyId } from '@dreamdevops/shared-kernel';
import { keyFingerprint, newToken, REGISTRATION_MINUTES } from '../domain/agent-identity.ts';
import {
  acceptedImageKinds,
  acceptsFeatureImages,
  type EnvironmentKind,
  type EnvironmentStatus,
  environmentSlug,
  normalizeEnvironmentName,
  parseKind,
} from '../domain/environment.ts';
import { EnvironmentError } from '../domain/errors.ts';
import {
  findProvider,
  HOSTING_PROVIDERS,
  type HostingProvider,
  type HostingSettings,
  KUBERNETES_PROVIDER,
  LOCAL_PROVIDER,
  parseSettings,
} from '../domain/hosting-providers.ts';
import type { EnvironmentsSession, EnvironmentsStore, StoredEnvironment, StoredTarget } from './ports.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EnvironmentsOptions {
  /** Where agents reach the API. */
  readonly agentApiUrl: string;
  /** The agent's Helm chart. */
  readonly agentChart: string;
  /** Whether this server lets companies run applications on its own Docker. */
  readonly localHosting: boolean;
}

/** Each company's environments and the targets that run them. Every query runs in the current company. */
export class Environments implements EnvironmentDirectory {
  readonly #store: EnvironmentsStore;
  readonly #options: EnvironmentsOptions;

  constructor(store: EnvironmentsStore, options: EnvironmentsOptions) {
    this.#store = store;
    this.#options = options;
  }

  async list(statusValue: unknown): Promise<EnvironmentView[]> {
    const status = statusValue === undefined || statusValue === '' ? 'active' : statusValue;
    if (status !== 'active' && status !== 'archived') {
      throw new EnvironmentError('invalid', 'Choose active or archived environments.');
    }
    return this.#store.transaction(async (session) => {
      const environments = await session.listEnvironments(status);
      const targets = await session.currentTargets();
      const byEnvironment = new Map(targets.map((target) => [target.environmentId, target]));
      return environments.map((environment) => toView(environment, byEnvironment.get(environment.id) ?? null));
    });
  }

  async get(idValue: unknown): Promise<EnvironmentView> {
    const id = parseId(idValue, 'environment');
    return this.#store.transaction(async (session) => {
      const environment = await findOrFail(session, id);
      return toView(environment, await session.currentTarget(id));
    });
  }

  async create(
    actor: Principal,
    input: Unchecked<CreateEnvironment>,
  ): Promise<EnvironmentView> {
    const name = normalizeEnvironmentName(input.name);
    const kind = parseKind(input.kind);
    const featureImages = acceptsFeatureImages(kind, input.acceptsFeatureImages);
    const reason = authorize(actor, { name, kind }, 'create', input);
    const companyId = currentCompanyId();
    const id = randomUUID();

    return this.#store.transaction(async (session) => {
      // One at a time per company, so two people can't take the same name or short name.
      await session.lockNames();
      await assertNameFree(session, name, null);
      const slug = await freeSlug(session, name);
      await session.addEnvironment({ id, name, slug, kind, acceptsFeatureImages: featureImages, createdBy: actor.userId });
      await session.record([
        EnvironmentCreated.create({
          companyId,
          actorId: actor.userId,
          payload: { environmentId: id, name, slug, kind, acceptsFeatureImages: featureImages, ...(reason !== null && { reason }) },
        }),
      ]);
      return toView(await findOrFail(session, id), null);
    });
  }

  /**
   * Changes the name, whether a test environment accepts feature images, or whether
   * production deployments need a second person's approval. The kind stays fixed.
   */
  update(
    actor: Principal,
    idValue: unknown,
    input: Unchecked<UpdateEnvironment>,
  ): Promise<void> {
    const id = parseId(idValue, 'environment');
    const name = input.name === undefined ? undefined : normalizeEnvironmentName(input.name);
    return this.#store.transaction(async (session) => {
      const current = await findOrFail(session, id, { lock: true });
      if (current.status === 'archived') {
        throw new EnvironmentError('conflict', 'Restore the environment first.');
      }
      const featureImages =
        input.acceptsFeatureImages === undefined
          ? current.acceptsFeatureImages
          : acceptsFeatureImages(current.kind, input.acceptsFeatureImages);
      const requiresApproval = input.requiresApproval === undefined ? current.requiresApproval : input.requiresApproval;
      if (typeof requiresApproval !== 'boolean') {
        throw new EnvironmentError('invalid', 'Say whether deployments need approval.');
      }
      if (requiresApproval && current.kind !== 'production') {
        throw new EnvironmentError('invalid', 'Only production deployments can need approval.');
      }
      const changes: {
        requiresApproval?: boolean;
        name?: string;
        previousName?: string;
        acceptsFeatureImages?: boolean;
        reason?: string;
      } = {};
      if (requiresApproval !== current.requiresApproval) {
        changes.requiresApproval = requiresApproval;
      }
      if (name !== undefined && name !== current.name) {
        await assertNameFree(session, name, id);
        changes.name = name;
        changes.previousName = current.name;
      }
      if (featureImages !== current.acceptsFeatureImages) {
        changes.acceptsFeatureImages = featureImages;
      }
      if (Object.keys(changes).length === 0) {
        return;
      }
      // Production is confirmed with the name it has now.
      const reason = authorize(actor, current, changes.name !== undefined ? 'rename' : 'change-approval', input);
      if (reason !== null) {
        changes.reason = reason;
      }
      await session.updateEnvironment(id, { name: name ?? current.name, acceptsFeatureImages: featureImages, requiresApproval });
      await session.record([
        EnvironmentUpdated.create({
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { environmentId: id, ...changes },
        }),
      ]);
    });
  }

  /** Hides the environment. It must have no target, so nothing keeps running unseen. */
  archive(actor: Principal, idValue: unknown, request: Unchecked<ProductionConfirmation> = {}): Promise<void> {
    return this.#setStatus(actor, idValue, 'archived', request);
  }

  restore(actor: Principal, idValue: unknown): Promise<void> {
    return this.#setStatus(actor, idValue, 'active', {});
  }

  #setStatus(
    actor: Principal,
    idValue: unknown,
    status: EnvironmentStatus,
    request: Unchecked<ProductionConfirmation>,
  ): Promise<void> {
    const id = parseId(idValue, 'environment');
    return this.#store.transaction(async (session) => {
      const current = await findOrFail(session, id, { lock: true });
      if (current.status === status) {
        return;
      }
      if (status === 'archived' && (await session.currentTarget(id)) !== null) {
        throw new EnvironmentError('conflict', 'Disconnect its target first.');
      }
      const reason = status === 'archived' ? authorize(actor, current, 'archive', request) : null;
      await session.setEnvironmentStatus(id, status);
      await session.record([
        (status === 'archived' ? EnvironmentArchived : EnvironmentRestored).create({
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { environmentId: id, name: current.name, ...(reason !== null && { reason }) },
        }),
      ]);
    });
  }

  /** Where environments can run, with what each needs, and whether it can be chosen here. */
  providers(): ProviderView[] {
    return HOSTING_PROVIDERS.map((provider) => ({ ...provider, unavailableReason: this.#unavailable(provider) }));
  }

  /**
   * Starts connecting a target. For a cluster: makes a one-time registration token and the
   * Helm command that installs the agent with it. A new token replaces one not used yet.
   */
  connect(actor: Principal, idValue: unknown, input: Unchecked<ConnectTarget> = {}): Promise<Connection> {
    const id = parseId(idValue, 'environment');
    const companyId = currentCompanyId();
    const provider = findProvider(input.provider ?? KUBERNETES_PROVIDER);
    if (provider === null) {
      throw new EnvironmentError('invalid', 'Choose where the environment runs.');
    }
    const unavailable = this.#unavailable(provider);
    if (unavailable !== null) {
      throw new EnvironmentError('conflict', unavailable);
    }
    const settings = parseSettings(provider, input.settings);
    if (provider.key === LOCAL_PROVIDER) {
      return this.#connectLocal(actor, id, settings);
    }
    return this.#store.transaction(async (session) => {
      const environment = await this.#connectable(session, actor, id);
      const targetId = randomUUID();
      const { token, hash } = newToken(targetId);
      const expiresAt = await session.addPendingTarget({
        id: targetId,
        environmentId: id,
        registrationTokenHash: hash,
        registrationMinutes: REGISTRATION_MINUTES,
        createdBy: actor.userId,
      });
      await session.record([
        TargetRegistrationStarted.create({
          companyId,
          actorId: actor.userId,
          payload: { environmentId: id, environmentName: environment.name, targetId },
        }),
      ]);
      return {
        targetId,
        provider: KUBERNETES_PROVIDER,
        registrationToken: token,
        expiresAt: expiresAt.toISOString(),
        command: this.#command(token),
      };
    });
  }

  /** This machine needs no agent, so it's connected at once. */
  #connectLocal(actor: Principal, id: string, settings: HostingSettings): Promise<Connection> {
    const companyId = currentCompanyId();
    return this.#store.transaction(async (session) => {
      const environment = await this.#connectable(session, actor, id);
      const targetId = randomUUID();
      await session.addConnectedTarget({ id: targetId, environmentId: id, provider: LOCAL_PROVIDER, settings, createdBy: actor.userId });
      await session.record([
        TargetConnected.create({
          companyId,
          actorId: actor.userId,
          payload: { environmentId: id, environmentName: environment.name, targetId, provider: LOCAL_PROVIDER },
        }),
      ]);
      return { targetId, provider: LOCAL_PROVIDER, registrationToken: null, expiresAt: null, command: null };
    });
  }

  /**
   * The environment, locked, if a target can connect to it now: it's active, and has no
   * target, or one still waiting for its agent, which the new one replaces.
   */
  async #connectable(session: EnvironmentsSession, actor: Principal, id: string): Promise<StoredEnvironment> {
    const environment = await findOrFail(session, id, { lock: true });
    if (environment.status === 'archived') {
      throw new EnvironmentError('conflict', 'Restore the environment first.');
    }
    authorize(actor, environment, 'connect-target', {});
    const existing = await session.currentTarget(id);
    if (existing !== null && existing.status !== 'pending') {
      throw new EnvironmentError('conflict', 'This environment already has a target. Disconnect it first.');
    }
    if (existing !== null) {
      await session.revokeTarget(existing.id, actor.userId);
    }
    return environment;
  }

  #unavailable(provider: HostingProvider): string | null {
    if (!provider.deploys) {
      return `${provider.name} targets aren't available yet.`;
    }
    if (provider.key === LOCAL_PROVIDER && !this.#options.localHosting) {
      return 'Running applications on this machine is turned off on this server. An administrator can turn it on with LOCAL_HOSTING=on.';
    }
    return null;
  }

  /** Cuts the target off: its key and tokens stop working at once, and a new one can connect. */
  disconnect(actor: Principal, idValue: unknown, request: Unchecked<ProductionConfirmation> = {}): Promise<void> {
    const id = parseId(idValue, 'environment');
    return this.#store.transaction(async (session) => {
      const environment = await findOrFail(session, id, { lock: true });
      const target = await session.currentTarget(id);
      if (target === null) {
        throw new EnvironmentError('conflict', 'This environment has no target.');
      }
      const reason = authorize(actor, environment, 'disconnect-target', request);
      await session.revokeTarget(target.id, actor.userId);
      await session.record([
        TargetRevoked.create({
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: {
            environmentId: id,
            environmentName: environment.name,
            targetId: target.id,
            provider: target.provider,
            wasConnected: target.status !== 'pending',
            ...(reason !== null && { reason }),
          },
        }),
      ]);
    });
  }

  /**
   * The agent installs into its own namespace and only calls out. The token is passed as
   * a value, which the chart keeps in a Secret; it works once and expires within the hour.
   */
  #command(token: string): string {
    return [
      `helm upgrade --install dreamdevops-agent ${this.#options.agentChart}`,
      '--namespace dreamdevops-system --create-namespace',
      `--set platformUrl=${this.#options.agentApiUrl}`,
      `--set registrationToken=${token}`,
    ].join(' \\\n  ');
  }
}

function parseId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new EnvironmentError('invalid', `The ${what} ID is not valid.`);
  }
  return value;
}

/** Another company's environment is never found, so its ID gets the same answer as a made-up one. */
async function findOrFail(session: EnvironmentsSession, id: string, options: { lock?: boolean } = {}): Promise<StoredEnvironment> {
  const environment = await session.findEnvironment(id, options);
  if (environment === null) {
    throw new EnvironmentError('not-found', 'This environment does not exist.');
  }
  return environment;
}

/** Archived environments keep their names, so a name always points to one environment. */
async function assertNameFree(session: EnvironmentsSession, name: string, exceptId: string | null): Promise<void> {
  const status = await session.statusOfName(name, exceptId);
  if (status !== null) {
    throw new EnvironmentError(
      'conflict',
      status === 'archived' ? 'An archived environment already has this name.' : 'Another environment already has this name.',
    );
  }
}

async function freeSlug(session: EnvironmentsSession, name: string): Promise<string> {
  for (let number = 1; number <= 100; number += 1) {
    const candidate = environmentSlug(name, number);
    if (!(await session.isSlugTaken(candidate))) {
      return candidate;
    }
  }
  throw new EnvironmentError('conflict', 'Too many environments have a similar name.');
}

function toView(environment: StoredEnvironment, target: StoredTarget | null): EnvironmentView {
  return {
    id: environment.id,
    name: environment.name,
    slug: environment.slug,
    kind: environment.kind,
    acceptsFeatureImages: environment.acceptsFeatureImages,
    acceptedImages: acceptedImageKinds({ kind: environment.kind, acceptsFeatureImages: environment.acceptsFeatureImages }),
    requiresApproval: environment.requiresApproval,
    status: environment.status,
    createdAt: environment.createdAt.toISOString(),
    archivedAt: environment.archivedAt?.toISOString() ?? null,
    target: target === null ? null : toTargetView(target),
  };
}

function toTargetView(target: StoredTarget): TargetView {
  return {
    id: target.id,
    provider: target.provider,
    settings: target.settings,
    status: target.status,
    registrationExpiresAt: target.status === 'pending' ? (target.registrationExpiresAt?.toISOString() ?? null) : null,
    keyFingerprint: target.publicKey === null ? null : keyFingerprint(target.publicKey),
    agentVersion: target.agentVersion,
    kubernetesVersion: target.kubernetesVersion,
    registeredAt: target.registeredAt?.toISOString() ?? null,
    lastSeenAt: target.lastSeenAt?.toISOString() ?? null,
    createdAt: target.createdAt.toISOString(),
  };
}

/** Applies production's protection to a change, and returns the reason to record. */
function authorize(
  actor: Principal,
  environment: { readonly name: string; readonly kind: EnvironmentKind },
  change: ProtectedChange,
  request: Unchecked<ProductionConfirmation>,
): string | null {
  return authorizeChange({ name: environment.name, production: environment.kind === 'production' }, change, {
    canManageProduction: actor.permissions.includes('environments-production:manage'),
    confirmation: request.confirmation,
    reason: request.reason,
  });
}
