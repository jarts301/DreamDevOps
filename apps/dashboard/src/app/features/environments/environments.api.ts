import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Step } from '../../shared/steps';

export type HostingKind = 'self-hosted' | 'cloud';
export type RecordStatus = 'active' | 'archived';

export interface SettingDefinition {
  readonly key: string;
  readonly label: string;
  readonly type: 'url' | 'hostname' | 'port' | 'text';
  readonly required: boolean;
  readonly defaultValue?: number;
  readonly example: string;
  readonly help: string | null;
}

export interface HostingProvider {
  readonly key: string;
  readonly name: string;
  readonly kind: HostingKind;
  readonly description: string;
  /** Whether the platform can deploy to it yet. */
  readonly deploys: boolean;
  readonly settings: readonly SettingDefinition[];
}

export interface ProviderSummary {
  readonly key: string;
  readonly name: string;
  readonly kind: HostingKind | null;
  readonly deploys: boolean;
}

export type HostingSettings = Readonly<Record<string, string | number>>;

export interface HostingTarget {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderSummary;
  readonly settings: HostingSettings;
  readonly status: RecordStatus;
  readonly version: number;
  readonly environments: number;
  /** How many environments have a version running on it now. */
  readonly running: number;
  readonly servesProduction: boolean;
  readonly createdAt: string;
  readonly archivedAt: string | null;
}

export interface Environment {
  readonly id: string;
  readonly applicationId: string;
  readonly name: string;
  readonly slug: string;
  readonly production: boolean;
  readonly status: RecordStatus;
  readonly version: number;
  readonly target: { readonly id: string; readonly name: string; readonly provider: ProviderSummary } | null;
  /** The version running in it now, or null when nothing runs. */
  readonly live: LiveVersion | null;
  /** How many variables and secrets it has. */
  readonly variables: number;
  /** Whether its variables changed since the version that runs now started. Deploying again applies them. */
  readonly settingsPending: boolean;
  /** The deployment queued or under way, if there is one. */
  readonly deploying: { readonly id: string; readonly kind: DeploymentKind; readonly status: DeploymentStatus; readonly version: string | null } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export type ImageKind = 'development' | 'release-candidate' | 'hotfix-candidate' | 'release';
export type DeploymentKind = 'deploy' | 'move' | 'stop';
export type DeploymentStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface LiveVersion {
  readonly deploymentId: string;
  /** The build it came from, to deploy it again. */
  readonly buildId: string | null;
  readonly version: string;
  readonly imageKind: ImageKind | null;
  /** Only releases are productive. */
  readonly productive: boolean;
  readonly address: string | null;
  /** Where it runs. After a move that failed, that's still the previous target. */
  readonly target: { readonly id: string; readonly name: string };
  readonly since: string | null;
}

/** A variable or secret containers get when they start. A secret's value is never sent back. */
export interface Variable {
  readonly id: string;
  readonly environmentId: string;
  readonly name: string;
  readonly secret: boolean;
  readonly value: string | null;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: { readonly userId: string; readonly displayName: string | null } | null;
}

/** A version that could be deployed to an environment, and why it can't be, if it can't. */
export interface DeployOption {
  readonly buildId: string;
  readonly version: string;
  readonly kind: ImageKind;
  readonly productive: boolean;
  readonly builtAt: string;
  readonly problem: string | null;
  readonly live: boolean;
}

export interface Deployment {
  readonly id: string;
  readonly environmentId: string;
  readonly number: number;
  readonly kind: DeploymentKind;
  readonly status: DeploymentStatus;
  readonly version: string | null;
  readonly imageKind: ImageKind | null;
  readonly productive: boolean;
  /** The image by digest, which is exactly what runs. */
  readonly image: string | null;
  readonly production: boolean;
  readonly target: { readonly id: string; readonly name: string; readonly provider: ProviderSummary };
  readonly previousTarget: { readonly id: string; readonly name: string } | null;
  readonly address: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly requestedBy: { readonly userId: string; readonly displayName: string | null } | null;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly steps: readonly Step[];
}

/** What a change to production must come with: the protected thing's name, typed, and a reason. */
export interface ProductionConfirmation {
  readonly confirmation: string;
  readonly reason: string;
}

@Injectable({ providedIn: 'root' })
export class EnvironmentsApi {
  readonly #http = inject(HttpClient);

  providers(): Promise<HostingProvider[]> {
    return firstValueFrom(this.#http.get<HostingProvider[]>('/api/v1/company/hosting-providers'));
  }

  targets(status: RecordStatus): Promise<HostingTarget[]> {
    return firstValueFrom(this.#http.get<HostingTarget[]>('/api/v1/company/hosting-targets', { params: { status } }));
  }

  connectTarget(input: { name: string; provider: string; settings: Record<string, string> }): Promise<HostingTarget> {
    return firstValueFrom(this.#http.post<HostingTarget>('/api/v1/company/hosting-targets', input));
  }

  updateTarget(
    target: HostingTarget,
    changes: { name?: string; settings?: Record<string, string> },
    confirmation?: ProductionConfirmation,
  ): Promise<HostingTarget> {
    return firstValueFrom(
      this.#http.patch<HostingTarget>(`/api/v1/company/hosting-targets/${encodeURIComponent(target.id)}`, {
        ...changes,
        ...confirmation,
        version: target.version,
      }),
    );
  }

  setTargetStatus(target: HostingTarget, action: 'archive' | 'restore'): Promise<HostingTarget> {
    return firstValueFrom(
      this.#http.post<HostingTarget>(`/api/v1/company/hosting-targets/${encodeURIComponent(target.id)}/${action}`, {
        version: target.version,
      }),
    );
  }

  environments(applicationId: string, status: RecordStatus): Promise<Environment[]> {
    return firstValueFrom(
      this.#http.get<Environment[]>(`/api/v1/company/applications/${encodeURIComponent(applicationId)}/environments`, {
        params: { status },
      }),
    );
  }

  create(
    applicationId: string,
    input: { name: string; production: boolean; targetId: string | null; reason?: string },
  ): Promise<Environment> {
    return firstValueFrom(
      this.#http.post<Environment>(`/api/v1/company/applications/${encodeURIComponent(applicationId)}/environments`, input),
    );
  }

  update(
    environment: Environment,
    changes: { name?: string; targetId?: string | null },
    confirmation?: ProductionConfirmation,
  ): Promise<Environment> {
    return firstValueFrom(
      this.#http.patch<Environment>(`/api/v1/company/environments/${encodeURIComponent(environment.id)}`, {
        ...changes,
        ...confirmation,
        version: environment.version,
      }),
    );
  }

  /** Protect, unprotect, archive or restore an environment. */
  act(
    environment: Environment,
    action: 'protect' | 'unprotect' | 'archive' | 'restore',
    details: Partial<ProductionConfirmation> = {},
  ): Promise<Environment> {
    return firstValueFrom(
      this.#http.post<Environment>(`/api/v1/company/environments/${encodeURIComponent(environment.id)}/${action}`, {
        ...details,
        version: environment.version,
      }),
    );
  }

  /** The application's versions that built, and whether each may run in the environment. */
  versions(environment: Environment): Promise<DeployOption[]> {
    return firstValueFrom(
      this.#http.get<DeployOption[]>(`/api/v1/company/environments/${encodeURIComponent(environment.id)}/versions`),
    );
  }

  deployments(environmentId: string): Promise<Deployment[]> {
    return firstValueFrom(
      this.#http.get<Deployment[]>(`/api/v1/company/environments/${encodeURIComponent(environmentId)}/deployments`),
    );
  }

  deploy(environment: Environment, buildId: string, details: { confirmation?: string; reason?: string } = {}): Promise<Deployment> {
    return firstValueFrom(
      this.#http.post<Deployment>(`/api/v1/company/environments/${encodeURIComponent(environment.id)}/deployments`, {
        ...details,
        buildId,
      }),
    );
  }

  /** Stops what runs in the environment. Production needs its name typed and a reason. */
  stop(environment: Environment, details: Partial<ProductionConfirmation> = {}): Promise<Deployment> {
    return firstValueFrom(
      this.#http.post<Deployment>(`/api/v1/company/environments/${encodeURIComponent(environment.id)}/stop`, details),
    );
  }

  variables(environmentId: string): Promise<Variable[]> {
    return firstValueFrom(
      this.#http.get<Variable[]>(`/api/v1/company/environments/${encodeURIComponent(environmentId)}/variables`),
    );
  }

  addVariable(
    environmentId: string,
    input: { name: string; value: string; secret: boolean },
    confirmation?: ProductionConfirmation,
  ): Promise<Variable> {
    return firstValueFrom(
      this.#http.post<Variable>(`/api/v1/company/environments/${encodeURIComponent(environmentId)}/variables`, {
        ...input,
        ...confirmation,
      }),
    );
  }

  changeVariable(variable: Variable, value: string, confirmation?: ProductionConfirmation): Promise<Variable> {
    return firstValueFrom(
      this.#http.patch<Variable>(`/api/v1/company/variables/${encodeURIComponent(variable.id)}`, {
        value,
        ...confirmation,
        version: variable.version,
      }),
    );
  }

  removeVariable(variable: Variable, confirmation?: ProductionConfirmation): Promise<void> {
    return firstValueFrom(
      this.#http.delete<void>(`/api/v1/company/variables/${encodeURIComponent(variable.id)}`, {
        body: { ...confirmation, version: variable.version },
      }),
    );
  }
}
