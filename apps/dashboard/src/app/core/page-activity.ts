import { signal } from '@angular/core';
import { errorMessage } from './api-error';

/**
 * What happens to a page's success message when the person does something else:
 * cleared as soon as they start, cleared only if it fails, or the page has none.
 */
export type NoticeBehavior = 'clear-when-starting' | 'clear-on-failure' | 'no-notice';

/**
 * Shows that a page is busy with something the person asked for, and how it went. Every
 * page runs its actions through one, so they all report errors the same way.
 */
export class PageActivity {
  readonly working = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly #notices: NoticeBehavior;

  constructor(notices: NoticeBehavior) {
    this.#notices = notices;
  }

  /** Runs an action, showing any failure as a message. Returns whether it succeeded. */
  async run(work: () => Promise<void>): Promise<boolean> {
    this.error.set(null);
    if (this.#notices === 'clear-when-starting') {
      this.notice.set(null);
    }
    this.working.set(true);
    try {
      await work();
      return true;
    } catch (error) {
      if (this.#notices === 'clear-on-failure') {
        this.notice.set(null);
      }
      this.error.set(errorMessage(error));
      return false;
    } finally {
      this.working.set(false);
    }
  }

  /**
   * Runs a change that says what it did, then reloads either way: after a success to show
   * it, and after a failure, such as someone else's change meanwhile, so the next try
   * uses current data. A failed reload doesn't hide the change's own outcome.
   */
  async change(work: () => Promise<string>, reload: () => Promise<void>): Promise<boolean> {
    const succeeded = await this.run(async () => {
      this.notice.set(await work());
    });
    try {
      await reload();
    } catch {
      // The change's own outcome is already on screen.
    }
    if (!succeeded) {
      this.notice.set(null);
    }
    return succeeded;
  }
}
