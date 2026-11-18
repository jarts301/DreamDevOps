import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { BlueprintManifest } from '@dreamdevops/contracts/blueprints/http';
import type {
  ApplicationStatus,
  ApplicationType,
  ApplicationView,
  RegisterApplication,
  UpdateApplication,
} from '@dreamdevops/contracts/catalog/http';
import type { RepositoryView, SourceAccessView } from '@dreamdevops/contracts/source-governance/http';

// The API's answers are the catalog's, Source governance's and Blueprints' HTTP contracts,
// under the names the pages use.
export type { ApplicationStatus, ApplicationType, BlueprintChoice } from '@dreamdevops/contracts/catalog/http';
export type { RepositoryStatus, TeamKey } from '@dreamdevops/contracts/source-governance/http';
export type Application = ApplicationView;
export type Repository = RepositoryView;
export type SourceAccess = SourceAccessView;
export type Blueprint = BlueprintManifest;

@Injectable({ providedIn: 'root' })
export class CatalogApi {
  readonly #http = inject(HttpClient);

  types(): Promise<ApplicationType[]> {
    return firstValueFrom(this.#http.get<ApplicationType[]>('/api/v1/company/application-types'));
  }

  list(status: ApplicationStatus): Promise<Application[]> {
    return firstValueFrom(this.#http.get<Application[]>('/api/v1/company/applications', { params: { status } }));
  }

  register(input: RegisterApplication): Promise<Application> {
    return firstValueFrom(this.#http.post<Application>('/api/v1/company/applications', input));
  }

  update(id: string, input: UpdateApplication): Promise<unknown> {
    return firstValueFrom(this.#http.patch(`/api/v1/company/applications/${encodeURIComponent(id)}`, input));
  }

  archive(id: string): Promise<unknown> {
    return firstValueFrom(this.#http.post(`/api/v1/company/applications/${encodeURIComponent(id)}/archive`, {}));
  }

  get(id: string): Promise<Application> {
    return firstValueFrom(this.#http.get<Application>(`/api/v1/company/applications/${encodeURIComponent(id)}`));
  }

  repositories(): Promise<Repository[]> {
    return firstValueFrom(this.#http.get<Repository[]>('/api/v1/company/repositories'));
  }

  requestRepository(applicationId: string): Promise<unknown> {
    return firstValueFrom(
      this.#http.post(`/api/v1/company/applications/${encodeURIComponent(applicationId)}/repository`, {}),
    );
  }

  sourceAccess(): Promise<SourceAccess> {
    return firstValueFrom(this.#http.get<SourceAccess>('/api/v1/company/source-access'));
  }

  syncSourceAccess(): Promise<SourceAccess> {
    return firstValueFrom(this.#http.post<SourceAccess>('/api/v1/company/source-access/sync', {}));
  }

  blueprints(): Promise<Blueprint[]> {
    return firstValueFrom(this.#http.get<Blueprint[]>('/api/v1/blueprints'));
  }

  restore(id: string): Promise<unknown> {
    return firstValueFrom(this.#http.post(`/api/v1/company/applications/${encodeURIComponent(id)}/restore`, {}));
  }
}
