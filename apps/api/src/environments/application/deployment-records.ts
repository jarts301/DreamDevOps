import { randomUUID } from 'node:crypto';
import { createDomainEvent, currentCompanyId, isUuid } from '@dreamdevops/shared-kernel';
import { appendToOutbox, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { Principal } from '../../identity-access/domain/access.ts';
import type { Check, Fact, StepStatus } from '../../shared/progress.ts';
import {
  DEPLOYMENT_STEP_NAMES,
  type DeploymentKind,
  type DeploymentStatus,
  type DeploymentStep,
  type DeploymentStepKey,
  initialDeploymentSteps,
} from '../domain/deployment.ts';
import { EnvironmentError } from '../domain/errors.ts';
import type { DeploymentPayload, DeploymentQueuedPayload } from '../domain/events.ts';
import { providerSummary, type ProviderSummary } from './hosting-targets.ts';

export interface DeploymentRow {
  id: string;
  environment_id: string;
  application_id: string;
  number: number;
  kind: DeploymentKind;
  status: DeploymentStatus;
  build_id: string | null;
  version: string | null;
  image_kind: string | null;
  productive: boolean;
  repository: string | null;
  digest: string | null;
  production: boolean;
  target_id: string;
  target_name: string;
  target_provider: string;
  previous_target_id: string | null;
  previous_target_name: string | null;
  host_port: number | null;
  address: string | null;
  steps: DeploymentStep[];
  attempts: number;
  last_error: string | null;
  requested_by: string | null;
  requested_by_name: string | null;
  reason: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface DeploymentStepView {
  readonly key: DeploymentStepKey;
  readonly name: string;
  readonly status: StepStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly summary: string | null;
  readonly checks: readonly Check[];
  readonly facts: readonly Fact[];
}

export interface DeploymentView {
  readonly id: string;
  readonly environmentId: string;
  readonly applicationId: string;
  readonly number: number;
  readonly kind: DeploymentKind;
  readonly status: DeploymentStatus;
  readonly buildId: string | null;
  readonly version: string | null;
  /** Such as release or release-candidate. */
  readonly imageKind: string | null;
  readonly productive: boolean;
  /** The image by digest, which is exactly what runs. */
  readonly image: string | null;
  /** Whether the environment was production when this was asked for. */
  readonly production: boolean;
  readonly target: { readonly id: string; readonly name: string; readonly provider: ProviderSummary };
  readonly previousTarget: { readonly id: string; readonly name: string } | null;
  readonly port: number | null;
  /** Where people reach it, once it runs. */
  readonly address: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly requestedBy: { readonly userId: string; readonly displayName: string | null } | null;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly steps: readonly DeploymentStepView[];
}

export const SELECT_DEPLOYMENTS = `
  SELECT d.*, t.name AS target_name, t.provider AS target_provider, p.name AS previous_target_name
  FROM environments.deployments d
  JOIN environments.targets t ON t.id = d.target_id
  LEFT JOIN environments.targets p ON p.id = d.previous_target_id`;

export function imageReference(row: Pick<DeploymentRow, 'repository' | 'digest'>): string | null {
  return row.repository === null || row.digest === null ? null : `${row.repository}@${row.digest}`;
}

export function toDeploymentView(row: DeploymentRow): DeploymentView {
  return {
    id: row.id,
    environmentId: row.environment_id,
    applicationId: row.application_id,
    number: row.number,
    kind: row.kind,
    status: row.status,
    buildId: row.build_id,
    version: row.version,
    imageKind: row.image_kind,
    productive: row.productive,
    image: imageReference(row),
    production: row.production,
    target: { id: row.target_id, name: row.target_name, provider: providerSummary(row.target_provider) },
    previousTarget:
      row.previous_target_id === null ? null : { id: row.previous_target_id, name: row.previous_target_name ?? '' },
    port: row.host_port,
    address: row.address,
    attempts: row.attempts,
    lastError: row.last_error,
    requestedBy: row.requested_by === null ? null : { userId: row.requested_by, displayName: row.requested_by_name },
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    steps: row.steps.map((step) => ({ ...step, name: DEPLOYMENT_STEP_NAMES[step.key] })),
  };
}

export function parseDeploymentId(value: unknown): string {
  if (!isUuid(value)) {
    throw new EnvironmentError('invalid', 'The deployment ID is not valid.');
  }
  return value;
}

export async function findDeployment(tx: TenantTransaction, id: string): Promise<DeploymentRow | null> {
  const { rows } = await tx.query<DeploymentRow>(`${SELECT_DEPLOYMENTS} WHERE d.id = $1`, [id]);
  return rows[0] ?? null;
}

/** The image a deployment runs, as Builds published it. */
export interface ImageToDeploy {
  readonly buildId: string;
  readonly version: string;
  readonly kind: string;
  readonly productive: boolean;
  readonly repository: string;
  readonly digest: string;
}

export interface NewDeployment {
  readonly environment: { readonly id: string; readonly application_id: string; readonly name: string; readonly production: boolean };
  readonly applicationName: string;
  readonly kind: DeploymentKind;
  /** What to run. For a stop, what runs now, if anything. */
  readonly image: ImageToDeploy | null;
  readonly version: string | null;
  readonly target: { readonly id: string; readonly name: string; readonly provider: string };
  readonly previousTargetId: string | null;
  readonly actor: Principal;
  readonly reason: string | null;
}

/**
 * Saves a queued deployment and the event that starts it, together. Call it while
 * holding the environment's row lock, so numbers and the one-at-a-time rule hold.
 */
export async function insertDeployment(tx: TenantTransaction, deployment: NewDeployment): Promise<string> {
  const id = randomUUID();
  const { environment, image } = deployment;
  const { rows } = await tx.query<{ next: number }>(
    'SELECT coalesce(max(number), 0) + 1 AS next FROM environments.deployments WHERE environment_id = $1',
    [environment.id],
  );
  // The environment's row lock makes this check safe. A unique index backs it up.
  const { rows: active } = await tx.query(
    "SELECT 1 FROM environments.deployments WHERE environment_id = $1 AND status IN ('queued', 'running')",
    [environment.id],
  );
  if (active.length > 0) {
    throw new EnvironmentError('conflict', `A deployment to ${environment.name} is already in progress. Wait for it to finish.`);
  }
  await tx.query(
    `INSERT INTO environments.deployments
       (id, company_id, environment_id, application_id, number, kind, status, build_id, version, image_kind,
        productive, repository, digest, production, target_id, previous_target_id, steps, requested_by,
        requested_by_name, reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      id,
      currentCompanyId(),
      environment.id,
      environment.application_id,
      rows[0]!.next,
      deployment.kind,
      image?.buildId ?? null,
      deployment.version,
      image?.kind ?? null,
      image?.productive ?? false,
      image?.repository ?? null,
      image?.digest ?? null,
      environment.production,
      deployment.target.id,
      deployment.previousTargetId,
      JSON.stringify(initialDeploymentSteps(deployment.kind)),
      deployment.actor.userId,
      deployment.actor.displayName,
      deployment.reason,
    ],
  );
  await appendToOutbox(tx, [
    createDomainEvent<'DeploymentQueued', DeploymentQueuedPayload>({
      eventType: 'DeploymentQueued',
      companyId: currentCompanyId(),
      actorId: deployment.actor.userId,
      payload: {
        ...payloadOf(
          {
            id,
            environment_id: environment.id,
            application_id: environment.application_id,
            production: environment.production,
            kind: deployment.kind,
            version: deployment.version,
            image_kind: image?.kind ?? null,
            target_id: deployment.target.id,
            target_name: deployment.target.name,
            target_provider: deployment.target.provider,
            previous_target_id: deployment.previousTargetId,
          },
          { environmentName: environment.name, applicationName: deployment.applicationName },
        ),
        reason: deployment.reason,
      },
    }),
  ]);
  return id;
}

/** What every event about a deployment says. */
export function payloadOf(
  row: Pick<
    DeploymentRow,
    | 'id'
    | 'environment_id'
    | 'application_id'
    | 'production'
    | 'kind'
    | 'version'
    | 'image_kind'
    | 'target_id'
    | 'target_name'
    | 'target_provider'
    | 'previous_target_id'
  >,
  names: { readonly environmentName: string; readonly applicationName: string },
): DeploymentPayload {
  return {
    deploymentId: row.id,
    environmentId: row.environment_id,
    environmentName: names.environmentName,
    applicationId: row.application_id,
    applicationName: names.applicationName,
    production: row.production,
    kind: row.kind,
    version: row.version,
    imageKind: row.image_kind,
    targetId: row.target_id,
    targetName: row.target_name,
    provider: row.target_provider,
    previousTargetId: row.previous_target_id,
  };
}
