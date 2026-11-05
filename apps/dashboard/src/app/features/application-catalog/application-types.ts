import { ChangeDetectionStrategy, Component, computed, inject, type OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../core/api-error';
import { ApplicationCatalogApi, type ApplicationType, groupByLayer, orderedCommands } from './application-catalog.api';

/** What each application type needs from an application's repository. */
@Component({
  selector: 'app-application-types',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="breadcrumb">
      <a routerLink="/applications"><span aria-hidden="true">← </span>Applications</a>
    </p>
    <h1>Application types</h1>
    <p class="lead">
      Every application is registered as one of these types. A type says how DreamDevOps installs, checks, builds and
      runs it, so its repository must support these commands.
    </p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }
    @if (loading()) {
      <p class="muted">Loading…</p>
    }

    @for (group of groups(); track group.layer.key) {
      <h2 class="type-layer-heading">{{ group.layer.name }}</h2>
      <p class="muted">{{ group.layer.description }}</p>
      @for (type of group.types; track type.key) {
        <section class="card" [attr.aria-labelledby]="'heading-' + type.key">
          <h3 [id]="'heading-' + type.key">{{ type.name }} <code class="muted">{{ type.key }}</code></h3>
          <p>{{ type.description }}</p>
          <dl class="facts">
            <dt>Runtime</dt>
            <dd>{{ type.language.runtime.name }} {{ type.language.runtime.version }}, built on <code>{{ type.language.runtime.image }}</code></dd>
            <dt>Works with</dt>
            <dd>{{ type.frameworks.join(', ') }}, or any framework that follows these conventions</dd>
            <dt>Served as</dt>
            <dd>
              @if (type.serving.kind === 'static') {
                Static files built into <code>{{ type.serving.directory }}/</code>
              } @else {
                A process on port {{ type.serving.port }}, checked at <code>{{ type.serving.healthCheckPath }}</code>
              }
            </dd>
          </dl>
          @if (type.scaffolds.length > 0) {
            <h4>Scaffolds to start from</h4>
            <ul class="scaffold-list">
              @for (scaffold of type.scaffolds; track scaffold.key) {
                <li>
                  <strong>{{ scaffold.name }}</strong>: {{ scaffold.description }}
                  <span class="muted">Includes: {{ scaffold.includes.join(' · ') }}</span>
                </li>
              }
            </ul>
          }
          <h4>Commands</h4>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Step</th>
                  <th scope="col">Command</th>
                </tr>
              </thead>
              <tbody>
                @for (step of commands(type); track step.name) {
                  <tr>
                    <td>{{ step.name }}</td>
                    <td><code>{{ step.command }}</code></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }
    }
  `,
})
export class ApplicationTypes implements OnInit {
  readonly #api = inject(ApplicationCatalogApi);

  protected readonly types = signal<ApplicationType[]>([]);
  protected readonly groups = computed(() => groupByLayer(this.types()));
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly commands = orderedCommands;

  async ngOnInit(): Promise<void> {
    try {
      this.types.set(await this.#api.types());
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }
}
