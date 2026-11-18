import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { BuildView } from '@dreamdevops/contracts/builds/http';
import type { ChangeRunning, DeploymentView, RequestDeployment, RunningVersion } from '@dreamdevops/contracts/deployments/http';
import type { ReleaseKind, ReleasesOverview, ReleasesSynced, StartRelease } from '@dreamdevops/contracts/releases/http';
import type { ProductionConfirmation } from '../../shared/production-confirmation';

// The API's answers are Builds', Releases' and Deployments' HTTP contracts, under the names the pages use.
export type {
  BuildKind,
  BuildStatus,
  Check as BuildCheck,
  JobState,
  /** A build's steps: the pipeline's jobs, and the platform's own checks of the Dockerfile, the image and its signature. */
  BuildStep as PipelineJob,
} from '@dreamdevops/contracts/builds/http';
export type { DeploymentStatus, ResourceLimits, RunningVersion, Strategy } from '@dreamdevops/contracts/deployments/http';
export type { ReleaseKind, ReleaseView as Release } from '@dreamdevops/contracts/releases/http';
export type Build = BuildView;
export type Releases = ReleasesOverview;
export type Deployment = DeploymentView;

/** What people can do to a deployment, each a route of its own. */
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
  syncReleases(applicationId: string): Promise<ReleasesSynced> {
    return firstValueFrom(this.#http.post<ReleasesSynced>(`${applicationPath(applicationId)}/releases/sync`, {}));
  }

  startRelease(applicationId: string, kind: ReleaseKind, version: string): Promise<unknown> {
    const body: StartRelease = { kind, version };
    return firstValueFrom(this.#http.post(`${applicationPath(applicationId)}/releases`, body));
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

  /** Production needs its name typed to confirm. */
  deploy(
    applicationId: string,
    input: Pick<RequestDeployment, 'environment' | 'version' | 'strategy'>,
    confirmation?: ProductionConfirmation,
  ): Promise<Deployment> {
    const body: RequestDeployment = { ...input, ...confirmation };
    return firstValueFrom(this.#http.post<Deployment>(`${applicationPath(applicationId)}/deployments`, body));
  }

  running(filter: { application?: string; environment?: string }): Promise<RunningVersion[]> {
    return firstValueFrom(this.#http.get<RunningVersion[]>('/api/v1/company/running', { params: { ...filter } }));
  }

  /** Stops what runs, or runs it again with the environment's values as they are now. */
  changeRunning(
    running: RunningVersion,
    change: 'stop' | 'apply',
    confirmation?: ProductionConfirmation,
  ): Promise<Deployment> {
    const body: ChangeRunning = { environment: running.environment.id, ...confirmation };
    return firstValueFrom(this.#http.post<Deployment>(`${applicationPath(running.application.id)}/${change}`, body));
  }

  act(deploymentId: string, action: DeploymentAction, confirmation?: ProductionConfirmation): Promise<unknown> {
    return firstValueFrom(
      this.#http.post(`/api/v1/company/deployments/${encodeURIComponent(deploymentId)}/${action}`, { ...confirmation }),
    );
  }

  rebuildFinal(releaseId: string): Promise<unknown> {
    return firstValueFrom(this.#http.post(`/api/v1/company/releases/${encodeURIComponent(releaseId)}/final-build`, {}));
  }
}

function applicationPath(applicationId: string): string {
  return `/api/v1/company/applications/${encodeURIComponent(applicationId)}`;
}
