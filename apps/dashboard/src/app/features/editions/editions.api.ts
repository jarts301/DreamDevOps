import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type Edition = 'community' | 'commercial';

export const EDITION_NAMES: Readonly<Record<Edition, string>> = {
  community: 'Community',
  commercial: 'Commercial',
};

export interface Feature {
  readonly key: string;
  readonly name: string;
  readonly edition: Edition;
  readonly enabled: boolean;
}

export interface CompanyEntitlements {
  readonly edition: Edition;
  readonly features: readonly Feature[];
}

export interface CompanyEditionRow {
  readonly companyId: string;
  readonly companyName: string;
  readonly edition: Edition;
  readonly changedAt: string | null;
}

export interface EditionsOverview {
  readonly provider: { readonly name: string; readonly commercialAvailable: boolean; readonly detail: string | null };
  readonly companies: readonly CompanyEditionRow[];
}

@Injectable({ providedIn: 'root' })
export class EditionsApi {
  readonly #http = inject(HttpClient);

  company(): Promise<CompanyEntitlements> {
    return firstValueFrom(this.#http.get<CompanyEntitlements>('/api/v1/company/entitlements'));
  }

  platform(): Promise<EditionsOverview> {
    return firstValueFrom(this.#http.get<EditionsOverview>('/api/v1/platform/editions'));
  }

  setEdition(companyId: string, edition: Edition): Promise<unknown> {
    return firstValueFrom(
      this.#http.put(`/api/v1/platform/editions/${encodeURIComponent(companyId)}`, { edition }),
    );
  }
}
