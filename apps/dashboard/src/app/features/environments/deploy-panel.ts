import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, type OnInit, output, signal } from '@angular/core';
import { errorMessage } from '../../core/api-error';
import { imageKindName } from './deployment-labels';
import { type DeployOption, type Environment, EnvironmentsApi } from './environments.api';

/** What the person chose to deploy. */
export interface DeployRequest {
  readonly buildId: string;
  readonly version: string;
  readonly confirmation?: string;
  readonly reason?: string;
}

const MAX_REASON_LENGTH = 500;

/**
 * Chooses a version to deploy to one environment. Production offers only releases, and
 * asks for its name typed exactly, as the API does.
 */
@Component({
  selector: 'app-deploy-panel',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="deploy-panel" [class.production-confirmation]="environment().production" role="group" [attr.aria-label]="'Deploy to ' + environment().name">
      <p><strong>Deploy to {{ environment().name }}</strong></p>
      @if (error(); as message) {
        <p class="muted">{{ message }}</p>
      } @else if (options() === null) {
        <p class="muted">Loading versions…</p>
      } @else if (options()!.length === 0) {
        <p class="muted">Nothing has built yet. Versions appear here once a build is published and signed.</p>
      } @else {
        @if (environment().production) {
          <p>Production runs only releases: versions merged into main, tagged and signed. Candidates and development images can't be chosen.</p>
        }
        <div class="form-row">
          <label class="field">
            <span>Version</span>
            <select (change)="chosen.set(value($event))">
              <option value="" [selected]="chosen() === ''">Choose a version</option>
              @for (option of options(); track option.buildId) {
                <option [value]="option.buildId" [disabled]="option.problem !== null" [selected]="chosen() === option.buildId">
                  {{ option.version }} · {{ imageKindName(option.kind) }}{{ option.live ? ' · runs now' : '' }}
                </option>
              }
            </select>
          </label>
          @if (environment().production) {
            <label class="field">
              <span>Type {{ environment().name }} to confirm</span>
              <input type="text" autocomplete="off" spellcheck="false" [value]="typed()" (input)="typed.set(value($event))" />
            </label>
          }
        </div>
        @if (choice(); as option) {
          <p class="cell-note">
            {{ imageKindName(option.kind) }} {{ option.version }}, built {{ option.builtAt | date: 'medium' }}.
            @if (option.live) {
              It starts again with the environment's current variables and secrets.
            } @else if (environment().live; as live) {
              It replaces {{ live.version }} once it's healthy. If it isn't, {{ live.version }} runs again.
            }
          </p>
        }
        <label class="field field-wide">
          <span>Why (optional, kept in the audit log)</span>
          <textarea rows="2" [attr.maxlength]="maxReasonLength" [value]="reason()" (input)="reason.set(value($event))"></textarea>
        </label>
      }
      <div class="button-row">
        <button
          type="button"
          class="button"
          [class.button-primary]="!environment().production"
          [class.button-danger]="environment().production"
          [disabled]="!ready() || working()"
          (click)="submit()"
        >
          {{ choice() ? 'Deploy ' + choice()!.version : 'Deploy' }}
        </button>
        <button type="button" class="button" (click)="cancel.emit()">Cancel</button>
      </div>
    </div>
  `,
})
export class DeployPanel implements OnInit {
  readonly #api = inject(EnvironmentsApi);

  readonly environment = input.required<Environment>();
  /** A version to start with, such as the one that runs, to deploy it again. */
  readonly preselect = input<string | null>(null);
  readonly working = input(false);
  readonly deploy = output<DeployRequest>();
  readonly cancel = output<void>();

  protected readonly imageKindName = imageKindName;
  protected readonly maxReasonLength = MAX_REASON_LENGTH;
  protected readonly options = signal<DeployOption[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly chosen = signal('');
  protected readonly typed = signal('');
  protected readonly reason = signal('');

  protected readonly choice = computed(() => this.options()?.find((option) => option.buildId === this.chosen()) ?? null);
  protected readonly ready = computed(() => {
    const choice = this.choice();
    return (
      choice !== null &&
      choice.problem === null &&
      (!this.environment().production || this.typed() === this.environment().name)
    );
  });

  async ngOnInit(): Promise<void> {
    try {
      const options = await this.#api.versions(this.environment());
      this.options.set(options);
      // The newest version that may run here is chosen, as it's the usual one. When it runs
      // already, nothing is, so an older version is never deployed by accident.
      const newest = options.find((option) => option.problem === null);
      const preselected = options.find((option) => option.buildId === this.preselect() && option.problem === null);
      this.chosen.set(preselected?.buildId ?? (newest !== undefined && !newest.live ? newest.buildId : ''));
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
  }

  protected submit(): void {
    const choice = this.choice();
    if (choice === null) {
      return;
    }
    const reason = this.reason().trim();
    this.deploy.emit({
      buildId: choice.buildId,
      version: choice.version,
      ...(this.environment().production && { confirmation: this.typed() }),
      ...(reason !== '' && { reason }),
    });
  }
}
