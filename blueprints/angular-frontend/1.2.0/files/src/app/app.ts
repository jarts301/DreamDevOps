import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { APP_NAME } from './app-info';
import { RuntimeConfig } from './runtime-config';

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
  protected readonly name = APP_NAME;
  protected readonly config = inject(RuntimeConfig);
}
