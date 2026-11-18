import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  CompanyEditionView,
  CompanyEntitlements,
  Edition,
  EditionsOverview,
  FeatureView,
} from '@dreamdevops/contracts/editions/http';

// The API's answers are Editions' HTTP contract, under the names the pages use.
export type { CompanyEntitlements, Edition, EditionsOverview } from '@dreamdevops/contracts/editions/http';
export type Feature = FeatureView;
export type CompanyEditionRow = CompanyEditionView;

/** An edition's name, such as "Community", as Editions' contracts name it. */
export { editionName } from '@dreamdevops/contracts/editions/features';

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
