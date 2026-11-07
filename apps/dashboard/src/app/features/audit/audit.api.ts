import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface AuditEntry {
  readonly sequence: number;
  readonly eventType: string;
  readonly actor: { readonly userId: string; readonly displayName: string | null } | null;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
}

export interface ActivityEntry {
  readonly companyId: string;
  readonly companyName: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
}

export interface IntegrityCheck {
  readonly valid: boolean;
  readonly checked: number;
  readonly brokenAtSequence: number | null;
  readonly reason: string | null;
}

@Injectable({ providedIn: 'root' })
export class AuditApi {
  readonly #http = inject(HttpClient);

  companyLog(before: string | null): Promise<{ entries: AuditEntry[]; nextBefore: string | null }> {
    return firstValueFrom(
      this.#http.get<{ entries: AuditEntry[]; nextBefore: string | null }>('/api/v1/company/audit', {
        params: before === null ? {} : { before },
      }),
    );
  }

  verify(): Promise<IntegrityCheck> {
    return firstValueFrom(this.#http.get<IntegrityCheck>('/api/v1/company/audit/verify'));
  }

  myActivity(before: string | null): Promise<{ entries: ActivityEntry[]; nextBefore: string | null }> {
    return firstValueFrom(
      this.#http.get<{ entries: ActivityEntry[]; nextBefore: string | null }>('/api/v1/platform/audit', {
        params: before === null ? {} : { before },
      }),
    );
  }
}
