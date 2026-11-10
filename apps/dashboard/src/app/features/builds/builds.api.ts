import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Step } from '../../shared/steps';

export type BuildKind = 'development' | 'release-candidate' | 'hotfix-candidate' | 'release';
export type BuildStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type { Check, Fact, StepStatus } from '../../shared/steps';

export type BuildStep = Step;

export interface Build {
  readonly id: string;
  readonly applicationId: string;
  readonly number: number;
  readonly kind: BuildKind;
  readonly version: string;
  readonly status: BuildStatus;
  readonly branch: string;
  readonly pullRequest: number | null;
  readonly commit: string;
  readonly image: string | null;
  readonly digest: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly requestedBy: { readonly userId: string; readonly displayName: string | null } | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly steps: readonly BuildStep[];
}

export interface Versions {
  readonly onMain: string | null;
  readonly published: string | null;
  readonly next: { readonly minor: string; readonly major: string; readonly hotfix: string | null };
  readonly lines: readonly {
    readonly kind: 'release' | 'hotfix';
    readonly branch: string;
    readonly version: string;
    readonly latestCandidate: { readonly id: string; readonly version: string; readonly status: BuildStatus } | null;
  }[];
}

export interface FeaturePullRequest {
  readonly number: number;
  readonly title: string;
  readonly branch: string;
  readonly url: string;
  readonly commit: string;
  readonly latestBuild: {
    readonly id: string;
    readonly version: string;
    readonly status: BuildStatus;
    readonly commit: string;
  } | null;
}

export interface SigningKey {
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly publicKey: string;
}

const application = (id: string) => `/api/v1/company/applications/${encodeURIComponent(id)}`;

@Injectable({ providedIn: 'root' })
export class BuildsApi {
  readonly #http = inject(HttpClient);

  builds(applicationId: string): Promise<Build[]> {
    return firstValueFrom(this.#http.get<Build[]>(`${application(applicationId)}/builds`));
  }

  versions(applicationId: string): Promise<Versions> {
    return firstValueFrom(this.#http.get<Versions>(`${application(applicationId)}/versions`));
  }

  pullRequests(applicationId: string): Promise<FeaturePullRequest[]> {
    return firstValueFrom(this.#http.get<FeaturePullRequest[]>(`${application(applicationId)}/pull-requests`));
  }

  /** Asks the platform to look for merges into main it may have missed. */
  sync(applicationId: string): Promise<{ found: number }> {
    return firstValueFrom(this.#http.post<{ found: number }>(`${application(applicationId)}/builds/sync`, {}));
  }

  buildPullRequest(applicationId: string, number: number): Promise<Build> {
    return firstValueFrom(this.#http.post<Build>(`${application(applicationId)}/pull-requests/${number}/builds`, {}));
  }

  startRelease(applicationId: string, bump: 'minor' | 'major'): Promise<Build> {
    return firstValueFrom(this.#http.post<Build>(`${application(applicationId)}/releases`, { bump }));
  }

  startHotfix(applicationId: string): Promise<Build> {
    return firstValueFrom(this.#http.post<Build>(`${application(applicationId)}/hotfixes`, {}));
  }

  buildCandidate(applicationId: string, branch: string): Promise<Build> {
    return firstValueFrom(this.#http.post<Build>(`${application(applicationId)}/candidates`, { branch }));
  }

  retry(buildId: string): Promise<Build> {
    return firstValueFrom(this.#http.post<Build>(`/api/v1/company/builds/${encodeURIComponent(buildId)}/retry`, {}));
  }

  signingKey(): Promise<SigningKey> {
    return firstValueFrom(this.#http.get<SigningKey>('/api/v1/company/image-signing-key'));
  }
}
