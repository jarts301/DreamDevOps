import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-not-allowed',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>You don't have access to this page</h1>
    <p>Ask a Company Admin if you need it.</p>
    <p><a routerLink="/">Go to the overview</a></p>
  `,
})
export class NotAllowed {}

@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>This page doesn't exist</h1>
    <p><a routerLink="/">Go to the overview</a></p>
  `,
})
export class NotFound {}
