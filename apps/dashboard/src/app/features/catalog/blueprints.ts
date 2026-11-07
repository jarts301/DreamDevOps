import { ChangeDetectionStrategy, Component, computed, inject, type OnInit, signal } from '@angular/core';
import { errorMessage } from '../../core/api-error';
import { type Blueprint, CatalogApi } from './catalog.api';

const STRATEGY_NAMES: Readonly<Record<string, string>> = {
  recreate: 'Recreate',
  rolling: 'Rolling',
  'blue-green': 'Blue/green',
  canary: 'Canary',
  'a-b': 'A/B',
};

/** The blueprints new applications start from, with what each one sets up. */
@Component({
  selector: 'app-blueprints',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Blueprints</h1>
    <p class="lead">Every new application starts from the newest blueprint for its type.</p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }

    @if (loading()) {
      <p class="muted">Loading…</p>
    }

    @for (blueprint of latest(); track blueprint.key) {
      <section class="card" [attr.aria-labelledby]="'blueprint-' + blueprint.key">
        <h2 [id]="'blueprint-' + blueprint.key">{{ blueprint.name }} {{ blueprint.version }}</h2>
        <p>{{ blueprint.description }}</p>
        <div class="table-scroll">
          <table>
            <tbody>
              <tr>
                <th scope="row">Language</th>
                <td>{{ blueprint.language }}, {{ blueprint.framework }}</td>
              </tr>
              <tr>
                <th scope="row">Port</th>
                <td>{{ blueprint.runtime.port }}</td>
              </tr>
              <tr>
                <th scope="row">Health checks</th>
                <td>
                  <code>{{ blueprint.runtime.livenessPath }}</code>
                  @if (blueprint.runtime.readinessPath !== blueprint.runtime.livenessPath) {
                    and <code>{{ blueprint.runtime.readinessPath }}</code>
                  }
                </td>
              </tr>
              <tr>
                <th scope="row">Default resources</th>
                <td>{{ blueprint.runtime.resources.cpu }} CPU, {{ blueprint.runtime.resources.memory }} memory</td>
              </tr>
              <tr>
                <th scope="row">Settings</th>
                <td>{{ blueprint.runtime.configuration }}</td>
              </tr>
              <tr>
                <th scope="row">Telemetry</th>
                <td>{{ blueprint.telemetry }}</td>
              </tr>
              <tr>
                <th scope="row">Pipeline</th>
                <td><code>{{ blueprint.pipeline }}</code></td>
              </tr>
              <tr>
                <th scope="row">Deployment strategies</th>
                <td>{{ strategies(blueprint) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        @if (olderVersions(blueprint).length > 0) {
          <p class="cell-note">Older versions: {{ olderVersions(blueprint).join(', ') }}</p>
        }
      </section>
    }
  `,
})
export class Blueprints implements OnInit {
  readonly #api = inject(CatalogApi);

  protected readonly all = signal<Blueprint[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  /** The API lists the newest version of each blueprint first. */
  protected readonly latest = computed(() =>
    this.all().filter((blueprint, index, list) => list.findIndex((other) => other.key === blueprint.key) === index),
  );

  async ngOnInit(): Promise<void> {
    try {
      this.all.set(await this.#api.blueprints());
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected strategies(blueprint: Blueprint): string {
    return blueprint.strategies.map((strategy) => STRATEGY_NAMES[strategy] ?? strategy).join(', ');
  }

  protected olderVersions(blueprint: Blueprint): string[] {
    return this.all()
      .filter((other) => other.key === blueprint.key && other.version !== blueprint.version)
      .map((other) => other.version);
  }
}
