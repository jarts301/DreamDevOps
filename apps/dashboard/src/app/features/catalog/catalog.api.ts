import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type ApplicationStatus = 'active' | 'archived';

/** A blueprint an application can start from: a language and a framework, such as TypeScript and React. */
export interface BlueprintChoice {
  readonly key: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly language: string;
  readonly framework: string;
}

export interface ApplicationType {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** The blueprint applications of this type start from unless another is chosen. */
  readonly blueprint: BlueprintChoice;
  /** Every blueprint applications of this type can start from, by language and name. */
  readonly blueprints: readonly BlueprintChoice[];
}

export type RepositoryStatus = 'creating' | 'ready' | 'failed';

export interface Repository {
  readonly applicationId: string;
  readonly status: RepositoryStatus;
  readonly fullName: string;
  readonly url: string;
  readonly blueprint: { readonly key: string; readonly version: string } | null;
  readonly lastError: string | null;
}

export type TeamKey = 'developers' | 'tech-leads' | 'readers';

export interface SourceAccess {
  readonly signInUrl: string;
  readonly gitUrl: string;
  readonly hasAccount: boolean;
  readonly team: TeamKey;
}

export interface Blueprint {
  readonly key: string;
  readonly version: string;
  readonly applicationType: string;
  readonly name: string;
  readonly description: string;
  readonly language: string;
  readonly framework: string;
  readonly runtime: {
    readonly port: number;
    readonly livenessPath: string;
    readonly readinessPath: string;
    readonly resources: { readonly cpu: string; readonly memory: string };
    readonly configuration: string;
  };
  readonly telemetry: string;
  readonly pipeline: string;
  readonly strategies: readonly string[];
}

export interface Application {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly type: { readonly key: string; readonly name: string };
  /** The blueprint it started from, chosen when it was registered. */
  readonly blueprint: { readonly key: string; readonly name: string; readonly language: string; readonly framework: string } | null;
  readonly description: string;
  readonly status: ApplicationStatus;
  readonly createdAt: string;
  readonly createdBy: { readonly userId: string; readonly displayName: string | null } | null;
  readonly archivedAt: string | null;
}

@Injectable({ providedIn: 'root' })
export class CatalogApi {
  readonly #http = inject(HttpClient);

  types(): Promise<ApplicationType[]> {
    return firstValueFrom(this.#http.get<ApplicationType[]>('/api/v1/company/application-types'));
  }

  list(status: ApplicationStatus): Promise<Application[]> {
    return firstValueFrom(this.#http.get<Application[]>('/api/v1/company/applications', { params: { status } }));
  }

  register(input: { name: string; type: string; blueprint: string; description: string }): Promise<Application> {
    return firstValueFrom(this.#http.post<Application>('/api/v1/company/applications', input));
  }

  update(id: string, input: { name: string; description: string }): Promise<unknown> {
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
