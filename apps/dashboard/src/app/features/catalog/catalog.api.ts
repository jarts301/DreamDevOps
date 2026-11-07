import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type ApplicationStatus = 'active' | 'archived';

export interface ApplicationType {
  readonly key: string;
  readonly name: string;
  readonly description: string;
}

export interface Application {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly type: { readonly key: string; readonly name: string };
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

  register(input: { name: string; type: string; description: string }): Promise<Application> {
    return firstValueFrom(this.#http.post<Application>('/api/v1/company/applications', input));
  }

  update(id: string, input: { name: string; description: string }): Promise<unknown> {
    return firstValueFrom(this.#http.patch(`/api/v1/company/applications/${encodeURIComponent(id)}`, input));
  }

  archive(id: string): Promise<unknown> {
    return firstValueFrom(this.#http.post(`/api/v1/company/applications/${encodeURIComponent(id)}/archive`, {}));
  }

  restore(id: string): Promise<unknown> {
    return firstValueFrom(this.#http.post(`/api/v1/company/applications/${encodeURIComponent(id)}/restore`, {}));
  }
}
