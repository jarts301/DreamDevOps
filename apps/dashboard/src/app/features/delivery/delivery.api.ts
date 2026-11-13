import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type BuildKind = 'feature' | 'rc' | 'final' | 'check';
export type BuildStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'deleted';

/** A build's steps: the pipeline's jobs, and the platform's own checks of the Dockerfile, the image and its signature. */
export type PipelineJob = 'dockerfile' | 'secrets' | 'test' | 'image' | 'inspect' | 'scan' | 'sbom' | 'verify';
export type JobState = 'waiting' | 'running' | 'passed' | 'failed' | 'skipped';

/** One rule a step checked. A warning is shown but doesn't stop the build. */
export interface BuildCheck {
  readonly name: string;
  readonly outcome: 'passed' | 'failed' | 'warning';
  readonly detail: string | null;
}

export interface Build {
  readonly id: string;
  readonly applicationId: string;
  readonly kind: BuildKind;
  readonly branch: string | null;
  readonly commit: string;
  readonly tag: string;
  readonly version: string | null;
  readonly releaseId: string | null;
  readonly status: BuildStatus;
  readonly failureReason: string | null;
  readonly reports: {
    readonly secrets?: { readonly found: number };
    readonly tests?: { readonly passed: boolean; readonly log: string };
    /** The end of a failed image build's output. */
    readonly buildLog?: string;
    readonly image?: { readonly digest: string; readonly size: number };
    readonly scan?: {
      readonly critical: number;
      readonly high: number;
      readonly medium: number;
      readonly low: number;
      readonly unknown: number;
    };
    readonly sbom?: { readonly components: number };
  };
  readonly progress: readonly {
    readonly job: PipelineJob;
    readonly state: JobState;
    readonly startedAt: string | null;
    readonly checks: readonly BuildCheck[];
  }[];
  readonly imageRef: string | null;
  readonly digest: string | null;
  readonly signedWith: 'test' | 'release' | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export type ReleaseKind = 'release' | 'hotfix';

export interface Release {
  readonly id: string;
  readonly kind: ReleaseKind;
  readonly version: string;
  readonly branch: string;
  readonly status: 'open' | 'merged' | 'published';
  readonly candidates: readonly {
    readonly number: number;
    readonly commit: string;
    readonly tag: string;
    readonly buildId: string | null;
    readonly buildStatus: BuildStatus | null;
  }[];
  readonly mergeBackPullRequest: number | null;
  readonly finalBuildId: string | null;
  readonly finalBuildStatus: BuildStatus | null;
  readonly createdAt: string;
  readonly mergedAt: string | null;
  readonly publishedAt: string | null;
}

export interface Releases {
  readonly releases: readonly Release[];
  readonly suggestions: Readonly<Record<ReleaseKind, string>>;
}

export type Strategy = 'recreate' | 'rolling' | 'blue-green';

export type DeploymentStatus =
  | 'awaiting-approval'
  | 'rejected'
  | 'queued'
  | 'committed'
  | 'progressing'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'aborted'
  | 'superseded';

export interface Deployment {
  readonly id: string;
  readonly application: { readonly id: string; readonly name: string; readonly slug: string };
  readonly environment: { readonly id: string; readonly name: string; readonly kind: 'test' | 'production' };
  readonly version: { readonly buildId: string; readonly kind: string; readonly tag: string; readonly version: string | null };
  readonly strategy: Strategy;
  readonly status: DeploymentStatus;
  readonly message: string | null;
  readonly progress: {
    readonly applied?: boolean;
    readonly desired?: number;
    readonly updated?: number;
    readonly ready?: number;
    readonly available?: number;
  };
  readonly rollbackOf: string | null;
  readonly commit: string | null;
  readonly requestedBy: { readonly userId: string; readonly displayName: string | null } | null;
  readonly approvedBy: { readonly userId: string; readonly displayName: string | null } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

export type DeploymentAction = 'approve' | 'reject' | 'promote' | 'abort' | 'rollback';

@Injectable({ providedIn: 'root' })
export class DeliveryApi {
  readonly #http = inject(HttpClient);

  builds(applicationId: string): Promise<Build[]> {
    return firstValueFrom(this.#http.get<Build[]>(`${applicationPath(applicationId)}/builds`));
  }

  versions(applicationId: string): Promise<Build[]> {
    return firstValueFrom(this.#http.get<Build[]>(`${applicationPath(applicationId)}/versions`));
  }

  branches(applicationId: string): Promise<string[]> {
    return firstValueFrom(this.#http.get<string[]>(`${applicationPath(applicationId)}/branches`));
  }

  buildFeatureImage(applicationId: string, branch: string): Promise<Build> {
    return firstValueFrom(this.#http.post<Build>(`${applicationPath(applicationId)}/feature-builds`, { branch }));
  }

  releases(applicationId: string): Promise<Releases> {
    return firstValueFrom(this.#http.get<Releases>(`${applicationPath(applicationId)}/releases`));
  }

  /** Asks the platform to catch up on merges and pushes to release branches it missed. */
  syncReleases(applicationId: string): Promise<{ moved: number }> {
    return firstValueFrom(this.#http.post<{ moved: number }>(`${applicationPath(applicationId)}/releases/sync`, {}));
  }

  startRelease(applicationId: string, kind: ReleaseKind, version: string): Promise<unknown> {
    return firstValueFrom(this.#http.post(`${applicationPath(applicationId)}/releases`, { kind, version }));
  }

  deployments(filter: { application?: string; environment?: string }): Promise<Deployment[]> {
    const params: Record<string, string> = {};
    if (filter.application !== undefined) {
      params['application'] = filter.application;
    }
    if (filter.environment !== undefined) {
      params['environment'] = filter.environment;
    }
    return firstValueFrom(this.#http.get<Deployment[]>('/api/v1/company/deployments', { params }));
  }

  deploy(applicationId: string, input: { environment: string; version: string; strategy: Strategy }): Promise<Deployment> {
    return firstValueFrom(this.#http.post<Deployment>(`${applicationPath(applicationId)}/deployments`, input));
  }

  act(deploymentId: string, action: DeploymentAction): Promise<unknown> {
    return firstValueFrom(this.#http.post(`/api/v1/company/deployments/${encodeURIComponent(deploymentId)}/${action}`, {}));
  }

  rebuildFinal(releaseId: string): Promise<unknown> {
    return firstValueFrom(this.#http.post(`/api/v1/company/releases/${encodeURIComponent(releaseId)}/final-build`, {}));
  }
}

function applicationPath(applicationId: string): string {
  return `/api/v1/company/applications/${encodeURIComponent(applicationId)}`;
}
