import { Injectable, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { type RouterStateSnapshot, TitleStrategy } from '@angular/router';
import about from '../about.json';

/** Titles each page "Page · App name", so browser tabs and history say where you are. */
@Injectable()
export class AppTitleStrategy extends TitleStrategy {
  readonly #title = inject(Title);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const page = this.buildTitle(snapshot);
    this.#title.setTitle(page === undefined ? about.name : `${page} · ${about.name}`);
  }
}
