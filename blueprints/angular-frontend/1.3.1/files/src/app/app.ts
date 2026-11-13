import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { APP_NAME } from './app-info';
import { RuntimeConfig } from './runtime-config';
import { newTraceparent, traceIdOf } from './trace-context';

interface Check {
  readonly answered: boolean;
  readonly message: string;
  readonly traceId: string;
}

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main>
      <h1>{{ name }}</h1>
      <p>Your web frontend is running.</p>
      <p>
        It calls its API at <code>{{ config.settings().apiUrl }}</code>.
      </p>
      <section aria-labelledby="check-heading">
        <h2 id="check-heading">Check the API</h2>
        <p>Pings the API, and starts a trace you can follow in DreamDevOps, under Monitoring.</p>
        <button type="button" [disabled]="checking()" (click)="checkApi()">Check the API</button>
        @if (check(); as result) {
          <p role="status">
            {{ result.message }} Trace ID: <code>{{ result.traceId }}</code>
          </p>
        }
      </section>
    </main>
  `,
  styles: `
    main {
      max-width: 40rem;
      margin: 4rem auto;
      padding: 0 1rem;
    }
  `,
})
export class App {
  readonly #http = inject(HttpClient);
  protected readonly name = APP_NAME;
  protected readonly config = inject(RuntimeConfig);
  protected readonly checking = signal(false);
  protected readonly check = signal<Check | null>(null);

  /** Calls the API's ping, with a trace of its own, so the API's logs and trace for it can be found. */
  protected async checkApi(): Promise<void> {
    const traceparent = newTraceparent();
    const traceId = traceIdOf(traceparent);
    const url = `${this.config.settings().apiUrl.replace(/\/$/, '')}/ping`;
    this.checking.set(true);
    try {
      await firstValueFrom(this.#http.get(url, { headers: { traceparent } }));
      this.check.set({ answered: true, message: 'The API answered.', traceId });
    } catch (error) {
      const status = error instanceof HttpErrorResponse && error.status !== 0 ? ` (HTTP ${error.status})` : '';
      this.check.set({ answered: false, message: `The API didn't answer${status}.`, traceId });
    } finally {
      this.checking.set(false);
    }
  }
}
