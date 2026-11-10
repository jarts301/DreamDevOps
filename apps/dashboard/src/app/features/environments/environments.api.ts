import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type EnvironmentKind = 'test' | 'production';
export type EnvironmentStatus = 'active' | 'archived';
export type TargetStatus = 'pending' | 'connected' | 'lost';

export interface Target {
  readonly id: string;
  readonly status: TargetStatus;
  readonly registrationExpiresAt: string | null;
  readonly keyFingerprint: string | null;
  readonly agentVersion: string | null;
  readonly kubernetesVersion: string | null;
  readonly registeredAt: string | null;
  readonly lastSeenAt: string | null;
  readonly createdAt: string;
}

export interface Environment {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly kind: EnvironmentKind;
  readonly acceptsFeatureImages: boolean;
  readonly acceptedImages: readonly string[];
  readonly status: EnvironmentStatus;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  readonly target: Target | null;
}

export interface Connection {
  readonly targetId: string;
  readonly registrationToken: string;
  readonly expiresAt: string;
  readonly command: string;
}

const BASE = '/api/v1/company/environments';

@Injectable({ providedIn: 'root' })
export class EnvironmentsApi {
  readonly #http = inject(HttpClient);

  list(status: EnvironmentStatus): Promise<Environment[]> {
    return firstValueFrom(this.#http.get<Environment[]>(BASE, { params: { status } }));
  }

  create(input: { name: string; kind: EnvironmentKind; acceptsFeatureImages: boolean }): Promise<Environment> {
    return firstValueFrom(this.#http.post<Environment>(BASE, input));
  }

  update(id: string, input: { name?: string; acceptsFeatureImages?: boolean }): Promise<void> {
    return firstValueFrom(this.#http.patch<void>(`${BASE}/${id}`, input));
  }

  archive(id: string): Promise<void> {
    return firstValueFrom(this.#http.post<void>(`${BASE}/${id}/archive`, {}));
  }

  restore(id: string): Promise<void> {
    return firstValueFrom(this.#http.post<void>(`${BASE}/${id}/restore`, {}));
  }

  connect(id: string): Promise<Connection> {
    return firstValueFrom(this.#http.post<Connection>(`${BASE}/${id}/target`, {}));
  }

  disconnect(id: string): Promise<void> {
    return firstValueFrom(this.#http.delete<void>(`${BASE}/${id}/target`));
  }
}
