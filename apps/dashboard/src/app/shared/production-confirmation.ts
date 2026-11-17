import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

/** What a change to production carries: its name, typed to confirm, and why. */
export interface ProductionConfirmation {
  readonly confirmation: string;
  readonly reason?: string;
}

/** A change waiting for its confirmation, for pages that hold one at a time. */
export interface PendingProductionChange {
  /** The production environment's name, which must be typed. */
  readonly environmentName: string;
  /** What's about to happen, such as "Disconnect the target of Production". */
  readonly what: string;
  /** The button's label, such as "Disconnect". */
  readonly action: string;
  /** Deploying, approving, promoting and aborting need no reason; other changes do. */
  readonly reasonRequired: boolean;
  readonly run: (confirmation: ProductionConfirmation) => Promise<void>;
}

/** The shortest and longest reason the API accepts for a change to production. */
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
      <p [id]="headingId"><strong>{{ what() }}</strong></p>
      <p>
        This affects production. To confirm, type <strong>{{ name() }}</strong> exactly{{ reasonRequired() ? ', and say why' : '' }}.
      </p>
      <label class="field">
        <span>Type {{ name() }} to confirm</span>
        <input type="text" autocomplete="off" spellcheck="false" [value]="typed()" (input)="typed.set(value($event))" />
      </label>
      <label class="field field-wide">
        <span
          >Why ({{ reasonRequired() ? '' : 'optional, ' }}{{ minLength }} to {{ maxLength }} characters, kept in the audit
          log)</span
        >
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
  /** What's about to happen, such as "Disconnect the target of Production". */
  readonly what = input.required<string>();
  /** The button's label. */
  readonly action = input.required<string>();
  readonly reasonRequired = input(true);
  readonly working = input(false);
  readonly confirm = output<ProductionConfirmation>();
  readonly cancel = output<void>();

  protected readonly minLength = MIN_REASON_LENGTH;
  protected readonly maxLength = MAX_REASON_LENGTH;
  protected readonly headingId = `production-confirmation-${Math.random().toString(36).slice(2)}`;
  protected readonly typed = signal('');
  protected readonly reason = signal('');
  protected readonly ready = computed(() => {
    const reason = this.reason().trim();
    const reasonOk = reason === '' ? !this.reasonRequired() : reason.length >= MIN_REASON_LENGTH;
    return this.typed() === this.name() && reasonOk;
  });

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected confirmed(): void {
    const reason = this.reason().trim();
    this.confirm.emit({ confirmation: this.typed(), ...(reason !== '' && { reason }) });
  }
}
