import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { ProductionConfirmation } from '../../shared/production-confirmation';

export type EnvironmentKind = 'test' | 'production';
export type EnvironmentStatus = 'active' | 'archived';
export type TargetStatus = 'pending' | 'connected' | 'lost';

export interface Target {
  readonly id: string;
  /** What runs the environment: a Kubernetes cluster with the agent, or This machine. */
  readonly provider: string;
  readonly settings: Readonly<Record<string, string | number>>;
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
  readonly requiresApproval: boolean;
  readonly status: EnvironmentStatus;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  readonly target: Target | null;
}

export type ConfigScope = 'environment' | 'application';

export interface EnvironmentConfig {
  readonly variables: readonly { readonly name: string; readonly value: string; readonly scope: ConfigScope; readonly updatedAt: string }[];
  /** Names only: secret values can be replaced or deleted, never read. */
  readonly secrets: readonly { readonly name: string; readonly scope: ConfigScope; readonly updatedAt: string }[];
}

/** A place environments can run, and what it needs. */
export interface Provider {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly deploys: boolean;
  readonly settings: readonly { readonly key: string; readonly label: string; readonly example: string; readonly help: string | null }[];
  /** Why it can't be chosen here, or null when it can. */
  readonly unavailableReason: string | null;
}

export interface Connection {
  readonly targetId: string;
  readonly provider: string;
  /** For a cluster only: This machine needs no agent. */
  readonly registrationToken: string | null;
  readonly expiresAt: string | null;
  readonly command: string | null;
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

  get(id: string): Promise<Environment> {
    return firstValueFrom(this.#http.get<Environment>(`${BASE}/${id}`));
  }

  config(id: string, application?: string): Promise<EnvironmentConfig> {
    const params: Record<string, string> = application === undefined ? {} : { application };
    return firstValueFrom(this.#http.get<EnvironmentConfig>(`${BASE}/${id}/config`, { params }));
  }

  /** Production changes carry its name, typed to confirm, and a reason. */
  setValue(
    id: string,
    kind: 'variables' | 'secrets',
    name: string,
    value: string,
    application?: string,
    confirmation?: ProductionConfirmation,
  ): Promise<void> {
    return firstValueFrom(
      this.#http.put<void>(`${BASE}/${id}/${kind}/${encodeURIComponent(name)}`, {
        value,
        ...(application && { application }),
        ...confirmation,
      }),
    );
  }

  removeValue(
    id: string,
    kind: 'variables' | 'secrets',
    name: string,
    application?: string,
    confirmation?: ProductionConfirmation,
  ): Promise<void> {
    const params: Record<string, string> = application === undefined ? {} : { application };
    return firstValueFrom(
      this.#http.delete<void>(`${BASE}/${id}/${kind}/${encodeURIComponent(name)}`, { params, body: { ...confirmation } }),
    );
  }

  update(
    id: string,
    input: { name?: string; acceptsFeatureImages?: boolean; requiresApproval?: boolean },
    confirmation?: ProductionConfirmation,
  ): Promise<void> {
    return firstValueFrom(this.#http.patch<void>(`${BASE}/${id}`, { ...input, ...confirmation }));
  }

  archive(id: string, confirmation?: ProductionConfirmation): Promise<void> {
    return firstValueFrom(this.#http.post<void>(`${BASE}/${id}/archive`, { ...confirmation }));
  }

  restore(id: string): Promise<void> {
    return firstValueFrom(this.#http.post<void>(`${BASE}/${id}/restore`, {}));
  }

  providers(): Promise<Provider[]> {
    return firstValueFrom(this.#http.get<Provider[]>(`${BASE}/providers`));
  }

  connect(id: string, provider = 'kubernetes', settings: Readonly<Record<string, string>> = {}): Promise<Connection> {
    return firstValueFrom(this.#http.post<Connection>(`${BASE}/${id}/target`, { provider, settings }));
  }

  disconnect(id: string, confirmation?: ProductionConfirmation): Promise<void> {
    return firstValueFrom(this.#http.delete<void>(`${BASE}/${id}/target`, { body: { ...confirmation } }));
  }
}
