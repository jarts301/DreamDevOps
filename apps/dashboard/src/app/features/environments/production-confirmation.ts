import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { ProductionConfirmation } from './environments.api';

/** The shortest reason the API accepts for a change to production. */
const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 500;

/**
 * Asks for what a change to production needs: its name typed exactly, and a reason,
 * which the audit log keeps. The API checks both, whatever the browser does.
 */
@Component({
  selector: 'app-production-confirmation',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="production-confirmation" role="group" [attr.aria-labelledby]="headingId">
      <p [id]="headingId" class="production-confirmation-heading"><strong>{{ what() }}</strong></p>
      <p>
        This affects production. To confirm, type <strong>{{ name() }}</strong> exactly, and say why.
      </p>
      <label class="field">
        <span>Type {{ name() }} to confirm</span>
        <input type="text" autocomplete="off" spellcheck="false" [value]="typed()" (input)="typed.set(value($event))" />
      </label>
      <label class="field field-wide">
        <span>Why ({{ minLength }} to {{ maxLength }} characters, kept in the audit log)</span>
        <textarea rows="2" [attr.maxlength]="maxLength" [value]="reason()" (input)="reason.set(value($event))"></textarea>
      </label>
      <div class="button-row">
        <button type="button" class="button button-danger" [disabled]="!ready() || working()" (click)="confirmed()">
          {{ action() }}
        </button>
        <button type="button" class="button" (click)="cancel.emit()">Cancel</button>
      </div>
    </div>
  `,
})
export class ProductionConfirmationPanel {
  /** The name to type, such as "Production". */
  readonly name = input.required<string>();
  /** What's about to happen, such as "Remove production protection from Production". */
  readonly what = input.required<string>();
  /** The button's label. */
  readonly action = input.required<string>();
  readonly working = input(false);
  readonly confirm = output<ProductionConfirmation>();
  readonly cancel = output<void>();

  protected readonly minLength = MIN_REASON_LENGTH;
  protected readonly maxLength = MAX_REASON_LENGTH;
  protected readonly headingId = `production-confirmation-${Math.random().toString(36).slice(2)}`;
  protected readonly typed = signal('');
  protected readonly reason = signal('');
  protected readonly ready = computed(
    () => this.typed() === this.name() && this.reason().trim().length >= MIN_REASON_LENGTH,
  );

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected confirmed(): void {
    this.confirm.emit({ confirmation: this.typed(), reason: this.reason().trim() });
  }
}
