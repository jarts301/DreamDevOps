import { ChangeDetectionStrategy, Component, computed, inject, type OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PageActivity } from '../../core/page-activity';
import { SessionService } from '../../core/session.service';
import {
  EnvironmentsApi,
  type HostingKind,
  type HostingProvider,
  type HostingTarget,
  type ProductionConfirmation,
  type RecordStatus,
  type SettingDefinition,
} from './environments.api';
import { describeSettings, kindName } from './hosting-labels';
import { ProductionConfirmationPanel } from './production-confirmation';

type Editing =
  | { readonly id: string; readonly kind: 'edit' | 'archive' }
  | { readonly id: string; readonly kind: 'confirm-edit'; readonly changes: { name: string; settings: Record<string, string> } }
  | null;

const KINDS: readonly HostingKind[] = ['self-hosted', 'cloud'];

/**
 * The cloud accounts and servers a company's environments can run on. Choosing where an
 * environment runs, or moving it, happens on the Environments page.
 */
@Component({
  selector: 'app-hosting-targets',
  imports: [ProductionConfirmationPanel, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Hosting</h1>
    <p class="lead">
      The cloud accounts and servers your environments can run on. Move an environment to another target at any time on the
      <a routerLink="/environments">Environments</a> page.
    </p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }
    @if (notice(); as message) {
      <p class="alert alert-success" role="status">{{ message }}</p>
    }

    @if (canConnect()) {
      <section class="card" aria-labelledby="connect-heading">
        <h2 id="connect-heading">Connect a hosting target</h2>
        <div class="form-row">
          <label class="field">
            <span>Provider</span>
            <select (change)="chooseProvider(value($event))">
              @for (kind of kinds; track kind) {
                <optgroup [label]="kindName(kind)">
                  @for (provider of providersOf(kind); track provider.key) {
                    <option [value]="provider.key" [selected]="provider.key === providerKey()">{{ provider.name }}</option>
                  }
                </optgroup>
              }
            </select>
          </label>
          <label class="field">
            <span>Name</span>
            <input type="text" maxlength="80" autocomplete="off" [value]="newName()" (input)="newName.set(value($event))" />
          </label>
        </div>
        @if (provider(); as chosen) {
          <p class="cell-note">
            {{ chosen.description }}
            {{ chosen.deploys ? 'DreamDevOps deploys here.' : 'You can plan environments here now. Deploying here comes later.' }}
          </p>
          <div class="form-row">
            @for (setting of chosen.settings; track setting.key) {
              <label class="field">
                <span>{{ setting.label }}{{ setting.required ? '' : ' (optional)' }}</span>
                <input
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  [attr.inputmode]="setting.type === 'port' ? 'numeric' : null"
                  [placeholder]="setting.example"
                  [value]="newSettings()[setting.key] ?? ''"
                  (input)="setNewSetting(setting, $event)"
                />
                @if (setting.help) {
                  <span class="cell-note">{{ setting.help }}</span>
                }
              </label>
            }
          </div>
          <div class="button-row">
            <button type="button" class="button button-primary" [disabled]="!canSubmit() || working()" (click)="connect()">
              Connect target
            </button>
          </div>
          <p class="cell-note">
            No credentials are asked for yet. When DreamDevOps starts setting up infrastructure, they'll be kept in a secret
            store, never in its database.
          </p>
        }
      </section>
    }

    <section class="card" aria-labelledby="targets-heading">
      <h2 id="targets-heading">{{ status() === 'active' ? 'Hosting targets' : 'Archived hosting targets' }}</h2>
      <div class="form-row" role="group" aria-label="Which targets to show">
        <button type="button" class="button" [attr.aria-pressed]="status() === 'active'" (click)="show('active')">Active</button>
        <button type="button" class="button" [attr.aria-pressed]="status() === 'archived'" (click)="show('archived')">Archived</button>
      </div>

      @if (targets().length === 0) {
        <p class="muted">{{ status() === 'active' ? 'No hosting targets yet.' : 'No archived hosting targets.' }}</p>
      } @else {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Target</th>
                <th scope="col">Settings</th>
                <th scope="col">Environments</th>
                @if (canConnect()) {
                  <th scope="col"><span class="visually-hidden">Actions</span></th>
                }
              </tr>
            </thead>
            <tbody>
              @for (target of targets(); track target.id) {
                <tr [attr.data-production]="target.servesProduction">
                  <td>
                    {{ target.name }}
                    <p class="cell-note">
                      {{ target.provider.name === target.name ? '' : target.provider.name + ' · ' }}{{ kindName(target.provider.kind) }}
                    </p>
                    <p class="cell-note">{{ target.provider.deploys ? 'Deploys here' : 'Deploying here comes later' }}</p>
                  </td>
                  <td>
                    @for (line of settingsOf(target); track line) {
                      <p class="cell-note"><code>{{ line }}</code></p>
                    }
                  </td>
                  <td>
                    {{ target.environments }}
                    @if (target.running > 0) {
                      <p class="cell-note">{{ target.running }} running a version</p>
                    }
                    @if (target.servesProduction) {
                      <span class="status" data-tone="production">Production runs here</span>
                    }
                  </td>
                  @if (canConnect()) {
                    <td class="cell-actions">
                      @if (target.status === 'archived') {
                        <button type="button" class="button" [attr.aria-label]="'Restore ' + target.name" [disabled]="working()" (click)="restore(target)">
                          Restore
                        </button>
                      } @else if (editing()?.id !== target.id) {
                        <button type="button" class="button" [attr.aria-label]="'Edit ' + target.name" (click)="open(target, 'edit')">Edit</button>
                        <button
                          type="button"
                          class="button"
                          [attr.aria-label]="'Archive ' + target.name"
                          [disabled]="target.environments > 0 || target.running > 0"
                          [attr.title]="target.environments > 0 || target.running > 0 ? 'Move or stop what runs on it first' : null"
                          (click)="open(target, 'archive')"
                        >
                          Archive
                        </button>
                      }
                    </td>
                  }
                </tr>
                @if (editing()?.id === target.id) {
                  <tr>
                    <td colspan="4">
                      @switch (editing()?.kind) {
                        @case ('edit') {
                          <div class="form-row">
                            <label class="field">
                              <span>Name of {{ target.name }}</span>
                              <input type="text" maxlength="80" autocomplete="off" [value]="editName()" (input)="editName.set(value($event))" />
                            </label>
                            @for (setting of providerOf(target)?.settings ?? []; track setting.key) {
                              <label class="field">
                                <span>{{ setting.label }}{{ setting.required ? '' : ' (optional)' }}</span>
                                <input
                                  type="text"
                                  autocomplete="off"
                                  spellcheck="false"
                                  [placeholder]="setting.example"
                                  [value]="editSettings()[setting.key] ?? ''"
                                  (input)="setEditSetting(setting, $event)"
                                />
                              </label>
                            }
                            <button type="button" class="button button-primary" [disabled]="working()" (click)="save(target)">Save</button>
                            <button type="button" class="button" (click)="close()">Cancel</button>
                          </div>
                          <p class="cell-note">Its provider stays the same. To move environments elsewhere, choose another target for them.</p>
                          @if (target.servesProduction) {
                            <p class="cell-note">Production runs here, so saving will ask for its name and a reason.</p>
                          }
                        }
                        @case ('confirm-edit') {
                          <app-production-confirmation
                            [name]="target.name"
                            [what]="'Change ' + target.name + ', which production runs on'"
                            action="Save the change"
                            [working]="working()"
                            (confirm)="saveConfirmed(target, $event)"
                            (cancel)="close()"
                          />
                        }
                        @case ('archive') {
                          <div class="form-row">
                            <p>Archive {{ target.name }}? Nothing is deleted, and you can restore it.</p>
                            <button type="button" class="button button-danger" [disabled]="working()" (click)="archive(target)">
                              Confirm archiving
                            </button>
                            <button type="button" class="button" (click)="close()">Cancel</button>
                          </div>
                        }
                      }
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
})
export class HostingTargets implements OnInit {
  readonly #api = inject(EnvironmentsApi);
  readonly #session = inject(SessionService);
  readonly #activity = new PageActivity('clear-on-failure');

  protected readonly working = this.#activity.working;
  protected readonly error = this.#activity.error;
  protected readonly notice = this.#activity.notice;
  protected readonly kinds = KINDS;
  protected readonly kindName = kindName;

  protected readonly providers = signal<HostingProvider[]>([]);
  protected readonly targets = signal<HostingTarget[]>([]);
  protected readonly status = signal<RecordStatus>('active');
  protected readonly editing = signal<Editing>(null);
  protected readonly providerKey = signal('');
  protected readonly newName = signal('');
  protected readonly newSettings = signal<Record<string, string>>({});
  protected readonly editName = signal('');
  protected readonly editSettings = signal<Record<string, string>>({});

  protected readonly canConnect = computed(() => {
    this.#session.user();
    return this.#session.can('targets:connect');
  });
  protected readonly provider = computed(() => this.providers().find((provider) => provider.key === this.providerKey()));
  protected readonly canSubmit = computed(() => {
    const provider = this.provider();
    return (
      provider !== undefined &&
      this.newName().trim().length >= 2 &&
      provider.settings.every((setting) => !setting.required || (this.newSettings()[setting.key] ?? '').trim() !== '')
    );
  });

  async ngOnInit(): Promise<void> {
    await this.#activity.run(async () => {
      const [providers] = await Promise.all([this.#api.providers(), this.#load()]);
      this.providers.set(providers);
      this.providerKey.set(providers[0]?.key ?? '');
    });
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected providersOf(kind: HostingKind): HostingProvider[] {
    return this.providers().filter((provider) => provider.kind === kind);
  }

  protected providerOf(target: HostingTarget): HostingProvider | undefined {
    return this.providers().find((provider) => provider.key === target.provider.key);
  }

  protected settingsOf(target: HostingTarget): string[] {
    return describeSettings(this.providerOf(target), target.settings);
  }

  protected chooseProvider(key: string): void {
    this.providerKey.set(key);
    this.newSettings.set({});
  }

  protected setNewSetting(setting: SettingDefinition, event: Event): void {
    this.newSettings.set({ ...this.newSettings(), [setting.key]: this.value(event) });
  }

  protected setEditSetting(setting: SettingDefinition, event: Event): void {
    this.editSettings.set({ ...this.editSettings(), [setting.key]: this.value(event) });
  }

  protected async show(status: RecordStatus): Promise<void> {
    this.status.set(status);
    this.close();
    this.notice.set(null);
    await this.#activity.run(() => this.#load());
  }

  protected open(target: HostingTarget, kind: 'edit' | 'archive'): void {
    this.editName.set(target.name);
    this.editSettings.set(Object.fromEntries(Object.entries(target.settings).map(([key, value]) => [key, String(value)])));
    this.editing.set({ id: target.id, kind });
  }

  protected close(): void {
    this.editing.set(null);
  }

  protected async connect(): Promise<void> {
    await this.#act(async () => {
      const target = await this.#api.connectTarget({
        name: this.newName().trim(),
        provider: this.providerKey(),
        settings: withoutBlanks(this.newSettings()),
      });
      this.newName.set('');
      this.newSettings.set({});
      this.status.set('active');
      return `${target.name} is connected. Environments can run on it now.`;
    });
  }

  /** A target production runs on first asks for its name and a reason. */
  protected async save(target: HostingTarget): Promise<void> {
    const changes = { name: this.editName().trim(), settings: withoutBlanks(this.editSettings()) };
    if (target.servesProduction) {
      this.editing.set({ id: target.id, kind: 'confirm-edit', changes });
      return;
    }
    await this.#act(async () => {
      const saved = await this.#api.updateTarget(target, changes);
      return `${saved.name} is saved.`;
    });
  }

  protected async saveConfirmed(target: HostingTarget, confirmation: ProductionConfirmation): Promise<void> {
    const editing = this.editing();
    if (editing?.kind !== 'confirm-edit') {
      return;
    }
    await this.#act(async () => {
      const saved = await this.#api.updateTarget(target, editing.changes, confirmation);
      return `${saved.name} is saved, and the reason is in the audit log.`;
    });
  }

  protected async archive(target: HostingTarget): Promise<void> {
    await this.#act(async () => {
      await this.#api.setTargetStatus(target, 'archive');
      return `${target.name} is archived. You can restore it from the archived list.`;
    });
  }

  protected async restore(target: HostingTarget): Promise<void> {
    await this.#act(async () => {
      await this.#api.setTargetStatus(target, 'restore');
      return `${target.name} is restored.`;
    });
  }

  /** Runs a change, closing what's open if it succeeds, and reloads either way. */
  async #act(work: () => Promise<string>): Promise<void> {
    await this.#activity.change(async () => {
      const message = await work();
      this.close();
      return message;
    }, () => this.#load());
  }

  async #load(): Promise<void> {
    this.targets.set(await this.#api.targets(this.status()));
  }
}

/** Settings left empty aren't sent, so optional ones fall back to their defaults. */
function withoutBlanks(settings: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value.trim() !== ''));
}
