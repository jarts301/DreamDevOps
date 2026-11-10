import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, type OnInit, output, signal } from '@angular/core';
import { PageActivity } from '../../core/page-activity';
import { type Environment, EnvironmentsApi, type ProductionConfirmation, type Variable } from './environments.api';
import { ProductionConfirmationPanel } from './production-confirmation';

/** What's about to change, held while production asks for its name and a reason. */
type Pending =
  | { readonly kind: 'add'; readonly name: string; readonly value: string; readonly secret: boolean }
  | { readonly kind: 'change'; readonly variable: Variable; readonly value: string }
  | { readonly kind: 'remove'; readonly variable: Variable };

/** The same rule as the API's, so mistakes show before anything is sent. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * An environment's variables and secrets, which its containers get when they start.
 * Every member sees variables' values, and only the names of secrets. Changes apply the
 * next time a version starts.
 */
@Component({
  selector: 'app-environment-variables',
  imports: [DatePipe, ProductionConfirmationPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="variables-panel" [attr.aria-label]="'Variables and secrets of ' + environment().name">
      <p>
        <strong>Variables and secrets of {{ environment().name }}</strong>
      </p>
      <p class="cell-note">
        Its containers get these as environment variables when they start, so changes apply the next time a version
        starts. Secrets are encrypted, and their values are never shown again. Every container also gets
        <code>DREAMDEVOPS_ENVIRONMENT</code>, <code>DREAMDEVOPS_PRODUCTION</code> and <code>DREAMDEVOPS_VERSION</code>.
      </p>

      @if (environment().settingsPending && environment().live; as live) {
        <div class="alert alert-info variables-pending" role="status">
          <span>{{ live.version }} started with older settings. Deploy it again to apply these.</span>
          @if (canDeploy()) {
            <button type="button" class="button" (click)="apply.emit()">Apply now</button>
          }
        </div>
      }
      @if (activity.error(); as message) {
        <p class="alert alert-error" role="alert">{{ message }}</p>
      }
      @if (activity.notice(); as message) {
        <p class="alert alert-success" role="status">{{ message }}</p>
      }

      @if (variables() === null) {
        <p class="muted">Loading…</p>
      } @else if (variables()!.length === 0) {
        <p class="muted">No variables or secrets yet.</p>
      } @else {
        <table class="variables-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Value</th>
              <th scope="col">Changed</th>
              @if (canManage()) {
                <th scope="col"><span class="visually-hidden">Actions</span></th>
              }
            </tr>
          </thead>
          <tbody>
            @for (variable of variables(); track variable.id) {
              <tr>
                <td><code>{{ variable.name }}</code></td>
                <td class="variable-value">
                  @if (editing() === variable.id) {
                    <label class="field">
                      <span class="visually-hidden">New value of {{ variable.name }}</span>
                      <input
                        [type]="variable.secret ? 'password' : 'text'"
                        autocomplete="off"
                        spellcheck="false"
                        [placeholder]="variable.secret ? 'Enter a new value' : ''"
                        [value]="editValue()"
                        (input)="editValue.set(value($event))"
                      />
                    </label>
                  } @else if (variable.secret) {
                    <span class="status">Secret</span>&ngsp;<span class="muted" aria-label="Hidden">••••••••</span>
                  } @else if (variable.value === '') {
                    <span class="muted">Empty</span>
                  } @else {
                    <code>{{ variable.value }}</code>
                  }
                </td>
                <td class="cell-note">
                  {{ variable.updatedAt | date: 'medium' }}
                  @if (variable.updatedBy?.displayName; as person) {
                    by {{ person }}
                  }
                </td>
                @if (canManage()) {
                  <td class="cell-actions">
                    @if (editing() === variable.id) {
                      <button type="button" class="button button-primary" [disabled]="activity.working() || !editReady(variable)" (click)="save(variable)">
                        Save
                      </button>
                      <button type="button" class="button" (click)="editing.set(null)">Cancel</button>
                    } @else {
                      <button type="button" class="button" [attr.aria-label]="(variable.secret ? 'Replace ' : 'Change ') + variable.name" (click)="edit(variable)">
                        {{ variable.secret ? 'Replace' : 'Change' }}
                      </button>
                      <button type="button" class="button" [attr.aria-label]="'Remove ' + variable.name" (click)="ask({ kind: 'remove', variable: variable })">
                        Remove
                      </button>
                    }
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      }

      @if (pending(); as change) {
        @if (environment().production) {
          <app-production-confirmation
            [name]="environment().name"
            [what]="describe(change)"
            action="Save the change"
            [working]="activity.working()"
            (confirm)="perform(change, $event)"
            (cancel)="pending.set(null)"
          />
        } @else {
          <div class="form-row">
            <p>{{ describe(change) }}?</p>
            <button type="button" class="button button-danger" [disabled]="activity.working()" (click)="perform(change)">Remove it</button>
            <button type="button" class="button" (click)="pending.set(null)">Cancel</button>
          </div>
        }
      }

      @if (canManage()) {
        <div class="form-row variables-add">
          <label class="field">
            <span>Name</span>
            <input type="text" autocomplete="off" spellcheck="false" placeholder="DATABASE_URL" [value]="newName()" (input)="newName.set(value($event))" />
          </label>
          <label class="field variables-add-value">
            <span>Value</span>
            <input
              [type]="newSecret() ? 'password' : 'text'"
              autocomplete="off"
              spellcheck="false"
              [value]="newValue()"
              (input)="newValue.set(value($event))"
            />
          </label>
          <label class="checkbox">
            <input type="checkbox" [checked]="newSecret()" (change)="newSecret.set(checked($event))" />
            <span>Secret</span>
          </label>
          <button type="button" class="button button-primary" [disabled]="!addReady() || activity.working()" (click)="addNew()">
            Add
          </button>
        </div>
        @if (newName() !== '' && !nameValid()) {
          <p class="cell-note">Use letters, digits and underscores, starting with a letter or underscore.</p>
        } @else {
          <p class="cell-note">
            Mark passwords, tokens and keys as secret. A secret can't be made visible later. Values fit on one line, so
            encode multi-line ones, such as keys, in base64.
          </p>
        }
      }
    </section>
  `,
})
export class EnvironmentVariables implements OnInit {
  readonly #api = inject(EnvironmentsApi);
  protected readonly activity = new PageActivity('clear-when-starting');

  readonly environment = input.required<Environment>();
  /** Whether the person may change this environment's variables. */
  readonly canManage = input(false);
  /** Whether the person may deploy to this environment, to apply changes. */
  readonly canDeploy = input(false);
  /** Something changed, so the page reloads the environment. */
  readonly changed = output<void>();
  /** The person asked to apply changes by deploying the running version again. */
  readonly apply = output<void>();

  protected readonly variables = signal<Variable[] | null>(null);
  protected readonly editing = signal<string | null>(null);
  protected readonly editValue = signal('');
  protected readonly pending = signal<Pending | null>(null);
  protected readonly newName = signal('');
  protected readonly newValue = signal('');
  protected readonly newSecret = signal(false);

  protected readonly nameValid = computed(() => NAME.test(this.newName().trim()) && !this.newName().trim().toUpperCase().startsWith('DREAMDEVOPS_'));
  protected readonly addReady = computed(() => this.nameValid() && (!this.newSecret() || this.newValue() !== ''));

  async ngOnInit(): Promise<void> {
    await this.activity.run(() => this.#load());
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  /** A secret's value is never shown, so replacing one starts empty. */
  protected edit(variable: Variable): void {
    this.pending.set(null);
    this.editValue.set(variable.secret ? '' : (variable.value ?? ''));
    this.editing.set(variable.id);
  }

  protected editReady(variable: Variable): boolean {
    return !variable.secret || this.editValue() !== '';
  }

  protected save(variable: Variable): void {
    this.ask({ kind: 'change', variable, value: this.editValue() });
  }

  protected addNew(): void {
    this.ask({ kind: 'add', name: this.newName().trim(), value: this.newValue(), secret: this.newSecret() });
  }

  /** Production first asks for its name and a reason. Elsewhere, only removing asks. */
  protected ask(change: Pending): void {
    if (this.environment().production || change.kind === 'remove') {
      this.pending.set(change);
      return;
    }
    void this.perform(change);
  }

  protected describe(change: Pending): string {
    const where = this.environment().name;
    switch (change.kind) {
      case 'add':
        return `Add the ${change.secret ? 'secret' : 'variable'} ${change.name} to ${where}`;
      case 'change':
        return `${change.variable.secret ? 'Replace the secret' : 'Change the variable'} ${change.variable.name} of ${where}`;
      case 'remove':
        return `Remove the ${change.variable.secret ? 'secret' : 'variable'} ${change.variable.name} from ${where}`;
    }
  }

  protected async perform(change: Pending, confirmation?: ProductionConfirmation): Promise<void> {
    const environmentId = this.environment().id;
    const succeeded = await this.activity.change(
      async () => {
        switch (change.kind) {
          case 'add':
            await this.#api.addVariable(environmentId, { name: change.name, value: change.value, secret: change.secret }, confirmation);
            this.newName.set('');
            this.newValue.set('');
            this.newSecret.set(false);
            return `${change.name} is added. It applies the next time a version starts.`;
          case 'change':
            await this.#api.changeVariable(change.variable, change.value, confirmation);
            this.editing.set(null);
            return `${change.variable.name} is saved. It applies the next time a version starts.`;
          case 'remove':
            await this.#api.removeVariable(change.variable, confirmation);
            return `${change.variable.name} is removed. Containers started from now on won't get it.`;
        }
      },
      () => this.#load(),
    );
    if (succeeded) {
      this.pending.set(null);
      this.changed.emit();
    }
  }

  async #load(): Promise<void> {
    this.variables.set(await this.#api.variables(this.environment().id));
  }
}
