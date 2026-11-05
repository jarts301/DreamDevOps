import { HttpClient } from '@angular/common/http';
import { inject, Injectable, InjectionToken } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type CompanyStatus = 'provisioning' | 'active' | 'suspended' | 'closed' | 'erased';
export type CompanyAction = 'suspend' | 'reactivate' | 'close';
export type ResourceStatus = 'pending' | 'ready' | 'failed' | 'erased';
export type ApplicationStatus = 'active' | 'archived';
export type ApplicationAction = 'archive' | 'restore';

export interface CompanyResource {
  readonly kind: string;
  readonly status: ResourceStatus;
  readonly name: string | null;
  readonly url: string | null;
}

/** What a Platform Admin sees of a resource, including why it failed. */
export interface PlatformCompanyResource extends CompanyResource {
  readonly lastError: string | null;
  readonly attempts: number;
  readonly updatedAt: string;
}

export interface PlatformCompany {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: CompanyStatus;
  readonly createdAt: string;
  readonly statusChangedAt: string;
  readonly erasedAt: string | null;
  readonly memberCount: number;
  readonly resources: readonly PlatformCompanyResource[];
}

export interface CompanyProfile {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: CompanyStatus;
  readonly resources: readonly CompanyResource[];
}

export interface Application {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  /** The Application Catalog type it was registered as, or null if it predates types. */
  readonly type: string | null;
  /** The scaffold its repository started from, or null if it started empty. */
  readonly scaffold: string | null;
  /** Its Git repository, or null if it predates repositories. */
  readonly repository: ApplicationRepository | null;
  readonly status: ApplicationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface ApplicationRepository {
  readonly status: ResourceStatus;
  readonly name: string | null;
  readonly url: string | null;
  readonly lastError: string | null;
}

export interface NewApplication {
  readonly type: string;
  /** Null for an empty repository. */
  readonly scaffold: string | null;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
}

/** How often a screen checks on work that happens in the background. Tests shorten it. */
export const POLL_INTERVAL_MS = new InjectionToken<number>('POLL_INTERVAL_MS', { factory: () => 2_000 });

export const SLUG_PATTERN = '[a-z0-9]+(-[a-z0-9]+)*';

/**
 * Suggests a slug the way the API does, such as "Acme Café" to "acme-cafe". The API
 * checks the slug again, so this only saves typing.
 */
export function suggestSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
}

@Injectable({ providedIn: 'root' })
export class TenancyApi {
  readonly #http = inject(HttpClient);

  companies(): Promise<PlatformCompany[]> {
    return firstValueFrom(this.#http.get<PlatformCompany[]>('/api/v1/platform/companies'));
  }

  company(companyId: string): Promise<PlatformCompany> {
    return firstValueFrom(this.#http.get<PlatformCompany>(companyPath(companyId)));
  }

  createCompany(name: string, slug: string): Promise<PlatformCompany> {
    return firstValueFrom(this.#http.post<PlatformCompany>('/api/v1/platform/companies', { name, slug }));
  }

  renameCompany(companyId: string, name: string): Promise<PlatformCompany> {
    return firstValueFrom(this.#http.patch<PlatformCompany>(companyPath(companyId), { name }));
  }

  changeCompanyStatus(companyId: string, action: CompanyAction): Promise<PlatformCompany> {
    return firstValueFrom(this.#http.post<PlatformCompany>(`${companyPath(companyId)}/${action}`, {}));
  }

  /** Permanent. The company must be closed, and the confirmation must be its slug. */
  eraseCompany(companyId: string, confirmation: string): Promise<PlatformCompany> {
    return firstValueFrom(this.#http.post<PlatformCompany>(`${companyPath(companyId)}/erase`, { confirmation }));
  }

  provisionCompany(companyId: string): Promise<PlatformCompany> {
    return firstValueFrom(this.#http.post<PlatformCompany>(`${companyPath(companyId)}/provisioning`, {}));
  }

  currentCompany(): Promise<CompanyProfile> {
    return firstValueFrom(this.#http.get<CompanyProfile>('/api/v1/company'));
  }

  applications(): Promise<Application[]> {
    return firstValueFrom(this.#http.get<Application[]>('/api/v1/company/applications'));
  }

  createApplication(application: NewApplication): Promise<Application> {
    return firstValueFrom(this.#http.post<Application>('/api/v1/company/applications', application));
  }

  updateApplication(applicationId: string, changes: { name: string; description: string }): Promise<Application> {
    return firstValueFrom(this.#http.patch<Application>(applicationPath(applicationId), changes));
  }

  /** Makes the repository again, after it failed. */
  requestRepository(applicationId: string): Promise<Application> {
    return firstValueFrom(this.#http.post<Application>(`${applicationPath(applicationId)}/repository`, {}));
  }

  changeApplicationStatus(applicationId: string, action: ApplicationAction): Promise<Application> {
    return firstValueFrom(this.#http.post<Application>(`${applicationPath(applicationId)}/${action}`, {}));
  }
}

function companyPath(companyId: string): string {
  return `/api/v1/platform/companies/${encodeURIComponent(companyId)}`;
}

function applicationPath(applicationId: string): string {
  return `/api/v1/company/applications/${encodeURIComponent(applicationId)}`;
}
