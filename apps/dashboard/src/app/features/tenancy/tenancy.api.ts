import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { CreatedInvitation } from '../identity-access/identity-access.api';

export type CompanyStatus = 'provisioning' | 'active' | 'provisioning-failed' | 'suspended';

export interface Company {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: CompanyStatus;
  readonly createdAt: string;
  readonly provisioningError: string | null;
}

@Injectable({ providedIn: 'root' })
export class TenancyApi {
  readonly #http = inject(HttpClient);

  list(): Promise<Company[]> {
    return firstValueFrom(this.#http.get<Company[]>('/api/v1/platform/companies'));
  }

  create(name: string, firstAdminEmail: string): Promise<{ company: Company; invitation: CreatedInvitation }> {
    return firstValueFrom(
      this.#http.post<{ company: Company; invitation: CreatedInvitation }>('/api/v1/platform/companies', {
        name,
        firstAdminEmail,
      }),
    );
  }

  rename(id: string, name: string): Promise<unknown> {
    return firstValueFrom(this.#http.patch(`/api/v1/platform/companies/${encodeURIComponent(id)}`, { name }));
  }

  suspend(id: string): Promise<unknown> {
    return firstValueFrom(this.#http.post(`/api/v1/platform/companies/${encodeURIComponent(id)}/suspend`, {}));
  }

  reactivate(id: string): Promise<unknown> {
    return firstValueFrom(this.#http.post(`/api/v1/platform/companies/${encodeURIComponent(id)}/reactivate`, {}));
  }

  retryProvisioning(id: string): Promise<unknown> {
    return firstValueFrom(this.#http.post(`/api/v1/platform/companies/${encodeURIComponent(id)}/provision`, {}));
  }

  inviteFirstAdmin(id: string, email: string): Promise<CreatedInvitation> {
    return firstValueFrom(
      this.#http.post<CreatedInvitation>(
        `/api/v1/platform/companies/${encodeURIComponent(id)}/first-admin-invitation`,
        { email },
      ),
    );
  }
}
