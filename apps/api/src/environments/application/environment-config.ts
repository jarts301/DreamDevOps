import {
  EnvironmentSecretRemoved,
  EnvironmentSecretSet,
  EnvironmentVariableRemoved,
  EnvironmentVariableSet,
} from '@dreamdevops/contracts/environments/events';
import { currentCompanyId } from '@dreamdevops/shared-kernel';
import type { ApplicationDirectory } from '@dreamdevops/contracts/catalog/services';
import type {
  ConfigScope,
  EnvironmentConfigView,
  ProductionConfirmation,
  SetValue,
} from '@dreamdevops/contracts/environments/http';
import { authorizeChange } from '@dreamdevops/contracts/environments/protection';
import type { EnvironmentValues, ResolvedConfig } from '@dreamdevops/contracts/environments/services';
import type { Unchecked } from '@dreamdevops/contracts/http';
import type { Principal } from '@dreamdevops/contracts/identity-access/access';
import type { EnvironmentKind } from '../domain/environment.ts';
import { EnvironmentError } from '../domain/errors.ts';
import { assertWithinLimits, parseVariableName, parseVariableValue } from '../domain/variables.ts';
import type { EnvironmentsSession, EnvironmentsStore, SecretStore, StoredValue, ValueKind, ValueScope } from './ports.ts';
import { secretsPath } from './target-configuration.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Each environment's variables and secrets, for all its applications or for one. Secret
 * values go straight to the secret store; the database keeps only their names. Changes
 * apply at the next deployment.
 */
export class EnvironmentConfig implements EnvironmentValues {
  readonly #store: EnvironmentsStore;
  readonly #secrets: SecretStore;
  readonly #applications: ApplicationDirectory;

  constructor(store: EnvironmentsStore, secrets: SecretStore, applications: ApplicationDirectory) {
    this.#store = store;
    this.#applications = applications;
    this.#secrets = secrets;
  }

  /** The environment's values, or with an application, its values and the environment's. */
  async view(environmentValue: unknown, applicationValue: unknown): Promise<EnvironmentConfigView> {
    const environmentId = parseId(environmentValue, 'environment');
    const applicationId = applicationValue === undefined || applicationValue === '' ? null : parseId(applicationValue, 'application');
    if (applicationId !== null) {
      await this.#applications.get(applicationId);
    }
    return this.#store.transaction(async (session) => {
      await findEnvironment(session, environmentId);
      const scope = { environmentId, applicationId };
      const variables = await session.values('variables', scope);
      const secrets = await session.values('secrets', scope);
      const scopeOf = (value: StoredValue): ConfigScope => (value.applicationId === null ? 'environment' : 'application');
      return {
        variables: variables.map((variable) => ({
          name: variable.name,
          value: variable.value!,
          scope: scopeOf(variable),
          updatedAt: variable.updatedAt.toISOString(),
          updatedBy: variable.updatedBy,
        })),
        secrets: secrets.map((secret) => ({
          name: secret.name,
          scope: scopeOf(secret),
          updatedAt: secret.updatedAt.toISOString(),
          updatedBy: secret.updatedBy,
        })),
      };
    });
  }

  async setVariable(actor: Principal, environmentValue: unknown, nameValue: unknown, input: Unchecked<SetValue>): Promise<void> {
    const name = parseVariableName(nameValue);
    const value = parseVariableValue(input.value, { secret: false });
    await this.#change(actor, environmentValue, input.application, input, async (session, scope) => {
      await assertNameFree(session, 'secrets', scope, name);
      await assertSameCase(session, 'variables', scope, name);
      await session.setVariable(scope, { name, value, updatedBy: actor.userId });
      assertWithinLimits(await session.sizes(scope));
      return { event: EnvironmentVariableSet, name };
    });
  }

  async removeVariable(
    actor: Principal,
    environmentValue: unknown,
    nameValue: unknown,
    applicationValue: unknown,
    request: Unchecked<ProductionConfirmation> = {},
  ): Promise<void> {
    const name = parseVariableName(nameValue);
    await this.#change(actor, environmentValue, applicationValue, request, async (session, scope) => {
      if (!(await session.removeValue('variables', scope, name))) {
        throw new EnvironmentError('not-found', 'There is no such variable.');
      }
      return { event: EnvironmentVariableRemoved, name };
    });
  }

  /** Saves the value in the secret store, and only the name here. */
  async setSecret(actor: Principal, environmentValue: unknown, nameValue: unknown, input: Unchecked<SetValue>): Promise<void> {
    const name = parseVariableName(nameValue);
    const value = parseVariableValue(input.value, { secret: true });
    await this.#change(actor, environmentValue, input.application, input, async (session, scope, application) => {
      await assertNameFree(session, 'variables', scope, name);
      await assertSameCase(session, 'secrets', scope, name);
      await session.setSecret(scope, { name, bytes: Buffer.byteLength(value, 'utf8'), updatedBy: actor.userId });
      assertWithinLimits(await session.sizes(scope));
      // Written last, inside the transaction: if the store refuses, the name isn't kept.
      await this.#secrets.write(secretPathOf(scope.environmentId, application), { [name]: value });
      return { event: EnvironmentSecretSet, name };
    });
  }

  async removeSecret(
    actor: Principal,
    environmentValue: unknown,
    nameValue: unknown,
    applicationValue: unknown,
    request: Unchecked<ProductionConfirmation> = {},
  ): Promise<void> {
    const name = parseVariableName(nameValue);
    await this.#change(actor, environmentValue, applicationValue, request, async (session, scope, application) => {
      if (!(await session.removeValue('secrets', scope, name))) {
        throw new EnvironmentError('not-found', 'There is no such secret.');
      }
      await this.#secrets.remove(secretPathOf(scope.environmentId, application), [name]);
      return { event: EnvironmentSecretRemoved, name };
    });
  }

  /**
   * The secret values an application gets in an environment: the environment's, then its
   * own, which win. Only for runtimes the platform drives itself, such as This machine:
   * a cluster's target reads them on its own, with its own token.
   */
  async openSecrets(environmentId: string, applicationSlug: string): Promise<Record<string, string>> {
    const base = secretsPath(currentCompanyId(), environmentId);
    const { token } = await this.#secrets.issueReadToken(`target-${environmentId}`, base);
    return {
      ...(await this.#secrets.read(token, secretPathOf(environmentId, null))),
      ...(await this.#secrets.read(token, secretPathOf(environmentId, applicationSlug))),
    };
  }

  /**
   * A fingerprint of the values an application gets in an environment. It changes whenever
   * one of them is set or removed, so deployments can tell when what runs has older ones.
   */
  fingerprint(environmentId: string, applicationId: string): Promise<string> {
    return this.#store.transaction((session) => session.fingerprint(environmentId, applicationId));
  }

  /** The fingerprints of several applications' values, in the order asked, in one transaction. */
  fingerprints(places: readonly { readonly environmentId: string; readonly applicationId: string }[]): Promise<string[]> {
    if (places.length === 0) {
      return Promise.resolve([]);
    }
    return this.#store.transaction(async (session) => {
      const hashes: string[] = [];
      for (const place of places) {
        hashes.push(await session.fingerprint(place.environmentId, place.applicationId));
      }
      return hashes;
    });
  }

  /** The variables an application gets in an environment, and where its secrets are. */
  resolve(environmentId: string, application: { readonly id: string; readonly slug: string }): Promise<ResolvedConfig> {
    return this.#store.transaction((session) => resolveIn(session, environmentId, application));
  }

  async #change(
    actor: Principal,
    environmentValue: unknown,
    applicationValue: unknown,
    request: Unchecked<ProductionConfirmation>,
    work: (session: EnvironmentsSession, scope: ValueScope, applicationSlug: string | null) => Promise<{ event: ValueEvent; name: string }>,
  ): Promise<void> {
    const environmentId = parseId(environmentValue, 'environment');
    const applicationId = applicationValue === undefined || applicationValue === null || applicationValue === '' ? null : parseId(applicationValue, 'application');
    const application = applicationId === null ? null : await this.#applications.get(applicationId);
    await this.#store.transaction(async (session) => {
      const environment = await findEnvironment(session, environmentId);
      assertMayManage(actor, environment.kind);
      const reason = authorizeChange({ name: environment.name, production: environment.kind === 'production' }, 'change-variables', {
        canManageProduction: actor.permissions.includes('environments-production:manage'),
        confirmation: request.confirmation,
        reason: request.reason,
      });
      const { event, name } = await work(session, { environmentId, applicationId }, application?.slug ?? null);
      // Only names: values never enter the history.
      await session.record([
        event.create({
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { environmentId, environmentName: environment.name, applicationId, name, ...(reason !== null && { reason }) },
        }),
      ]);
    });
  }
}

/** The variables an application gets in an environment, its own over the environment's, and where its secrets are. */
async function resolveIn(
  session: EnvironmentsSession,
  environmentId: string,
  application: { readonly id: string; readonly slug: string },
): Promise<ResolvedConfig> {
  const variables: Record<string, string> = {};
  for (const variable of await session.variablesFor(environmentId, application.id)) {
    variables[variable.name] = variable.value;
  }
  const secrets = await session.secretScopes(environmentId, application.id);
  return {
    variables,
    secretPaths: {
      shared: secretPathOf(environmentId, null),
      application: secretPathOf(environmentId, application.slug),
    },
    hasSharedSecrets: secrets.shared,
    hasApplicationSecrets: secrets.application,
  };
}

/** What changed about a variable or secret. Only its name is in the event, never its value. */
type ValueEvent = typeof EnvironmentVariableSet | typeof EnvironmentVariableRemoved | typeof EnvironmentSecretSet | typeof EnvironmentSecretRemoved;

/** Production's values belong to the people who run it; Company Admins manage test ones. */
export function assertMayManage(actor: Principal, kind: EnvironmentKind): void {
  const allowed =
    actor.permissions.includes('environment-config:manage') ||
    (kind === 'test' && actor.permissions.includes('test-environment-config:manage'));
  if (!allowed) {
    throw new EnvironmentError(
      'forbidden',
      kind === 'production'
        ? "Only Tech Leads and Operators manage production's variables and secrets."
        : "You can't manage this environment's variables and secrets.",
    );
  }
}

function secretPathOf(environmentId: string, applicationSlug: string | null): string {
  const base = secretsPath(currentCompanyId(), environmentId);
  return applicationSlug === null ? `${base}/shared` : `${base}/apps/${applicationSlug}`;
}

function parseId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new EnvironmentError('invalid', `The ${what} ID is not valid.`);
  }
  return value;
}

async function findEnvironment(session: EnvironmentsSession, id: string): Promise<{ name: string; kind: EnvironmentKind }> {
  const environment = await session.findEnvironment(id);
  if (environment === null) {
    throw new EnvironmentError('not-found', 'This environment does not exist.');
  }
  return environment;
}

/** A name is a variable or a secret, never both, in any case. */
async function assertNameFree(session: EnvironmentsSession, other: ValueKind, scope: ValueScope, name: string): Promise<void> {
  const existing = await session.nameInScope(other, scope, name);
  if (existing !== null) {
    throw new EnvironmentError(
      'conflict',
      `A ${other === 'secrets' ? 'secret' : 'variable'} is already named ${existing} here. A variable can't become a secret, nor the other way round.`,
    );
  }
}

/** Replacing a value keeps its name: one that differs only in case is another name, which isn't allowed. */
async function assertSameCase(session: EnvironmentsSession, kind: ValueKind, scope: ValueScope, name: string): Promise<void> {
  const existing = await session.nameInScope(kind, scope, name);
  if (existing !== null && existing !== name) {
    throw new EnvironmentError('conflict', `${existing} is already set here. Names can't differ only in case.`);
  }
}
