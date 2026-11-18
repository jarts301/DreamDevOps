import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { ActivityEntry, AuditEntry, HistoryPage, IntegrityCheck } from '@dreamdevops/contracts/audit/http';

// The API's answers are the audit log's HTTP contract.
export type { ActivityEntry, AuditEntry, HistoryPage, IntegrityCheck } from '@dreamdevops/contracts/audit/http';

@Injectable({ providedIn: 'root' })
export class AuditApi {
  readonly #http = inject(HttpClient);

  companyLog(before: string | null): Promise<HistoryPage<AuditEntry>> {
    return firstValueFrom(
      this.#http.get<HistoryPage<AuditEntry>>('/api/v1/company/audit', {
        params: before === null ? {} : { before },
      }),
    );
  }

  verify(): Promise<IntegrityCheck> {
    return firstValueFrom(this.#http.get<IntegrityCheck>('/api/v1/company/audit/verify'));
  }

  myActivity(before: string | null): Promise<HistoryPage<ActivityEntry>> {
    return firstValueFrom(
      this.#http.get<HistoryPage<ActivityEntry>>('/api/v1/platform/audit', {
        params: before === null ? {} : { before },
      }),
    );
  }
}
