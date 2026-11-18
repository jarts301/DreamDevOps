import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { ProductionConfirmation } from '../../shared/production-confirmation';

import type {
  Connection,
  ConnectTarget,
  CreateEnvironment,
  EnvironmentConfigView,
  EnvironmentStatus,
  EnvironmentView,
  ProviderView,
  SetValue,
  TargetView,
  UpdateEnvironment,
} from '@dreamdevops/contracts/environments/http';

// The API's answers are Environments' HTTP contract, under the names the pages use.
export type {
  ConfigScope,
  Connection,
  EnvironmentKind,
  EnvironmentStatus,
  TargetStatus,
} from '@dreamdevops/contracts/environments/http';
export type Target = TargetView;
export type Environment = EnvironmentView;
export type EnvironmentConfig = EnvironmentConfigView;
/** A place environments can run, and what it needs. */
export type Provider = ProviderView;

const BASE = '/api/v1/company/environments';

@Injectable({ providedIn: 'root' })
export class EnvironmentsApi {
  readonly #http = inject(HttpClient);

  list(status: EnvironmentStatus): Promise<Environment[]> {
    return firstValueFrom(this.#http.get<Environment[]>(BASE, { params: { status } }));
  }

  create(input: CreateEnvironment): Promise<Environment> {
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
    const body: SetValue = { value, ...(application && { application }), ...confirmation };
    return firstValueFrom(this.#http.put<void>(`${BASE}/${id}/${kind}/${encodeURIComponent(name)}`, body));
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
    input: Omit<UpdateEnvironment, 'confirmation' | 'reason'>,
    confirmation?: ProductionConfirmation,
  ): Promise<void> {
    const body: UpdateEnvironment = { ...input, ...confirmation };
    return firstValueFrom(this.#http.patch<void>(`${BASE}/${id}`, body));
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
    const body: ConnectTarget = { provider, settings };
    return firstValueFrom(this.#http.post<Connection>(`${BASE}/${id}/target`, body));
  }

  disconnect(id: string, confirmation?: ProductionConfirmation): Promise<void> {
    return firstValueFrom(this.#http.delete<void>(`${BASE}/${id}/target`, { body: { ...confirmation } }));
  }
}
