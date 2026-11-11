import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface Settings {
  readonly apiUrl: string;
}

/**
 * Settings read when the app starts, from /config.json. The container writes that file
 * from environment variables, so one image serves every environment.
 */
@Injectable({ providedIn: 'root' })
export class RuntimeConfig {
  readonly #http = inject(HttpClient);
  readonly #settings = signal<Settings>({ apiUrl: '/api' });

  readonly settings = this.#settings.asReadonly();

  async load(): Promise<void> {
    this.#settings.set(await firstValueFrom(this.#http.get<Settings>('/config.json')));
  }
}
