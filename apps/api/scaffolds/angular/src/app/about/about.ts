import { ChangeDetectionStrategy, Component } from '@angular/core';
import about from '../../about.json';

@Component({
  selector: 'app-about',
  template: `
    <h1>About</h1>
    @if (description) {
      <p class="description">{{ description }}</p>
    } @else {
      <p>Describe your app in <code>src/about.json</code>.</p>
    }
  `,
  styles: `
    .description {
      white-space: pre-line;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class About {
  protected readonly description = about.description;
}
