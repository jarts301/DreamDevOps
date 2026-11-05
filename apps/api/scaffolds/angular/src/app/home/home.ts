import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import about from '../../about.json';

@Component({
  selector: 'app-home',
  template: `
    <h1>{{ name }}</h1>
    <p>Edit <code>src/app/home/home.ts</code> to make this page your own.</p>
    <button type="button" (click)="increment()">Clicked {{ count() }} {{ times() }}</button>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
  protected readonly name = about.name;
  protected readonly count = signal(0);
  protected readonly times = computed(() => (this.count() === 1 ? 'time' : 'times'));

  protected increment(): void {
    this.count.update((count) => count + 1);
  }
}
