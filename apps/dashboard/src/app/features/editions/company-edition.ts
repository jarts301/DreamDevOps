import { ChangeDetectionStrategy, Component, computed, inject, type OnInit, signal } from '@angular/core';
import { errorMessage } from '../../core/api-error';
import { type CompanyEntitlements, EDITION_NAMES, EditionsApi } from './editions.api';

/** What the company's edition includes. Any member may look. */
@Component({
  selector: 'app-company-edition',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Edition</h1>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }

    @if (entitlements(); as current) {
      <p class="lead">Your company uses the {{ editionName() }} Edition.</p>

      <section class="card" aria-labelledby="included-heading">
        <h2 id="included-heading">Included</h2>
        <ul class="ability-list">
          @for (feature of included(); track feature.key) {
            <li>{{ feature.name }}</li>
          }
        </ul>
      </section>

      @if (unavailable().length > 0) {
        <section class="card" aria-labelledby="unavailable-heading">
          <h2 id="unavailable-heading">Not included</h2>
          @if (current.edition === 'community') {
            <p class="muted">These need the Commercial Edition. A Platform Admin can tell you more.</p>
          } @else {
            <p class="muted">Your company's license doesn't include these. A Platform Admin can tell you more.</p>
          }
          <ul class="ability-list muted">
            @for (feature of unavailable(); track feature.key) {
              <li>{{ feature.name }}</li>
            }
          </ul>
        </section>
      }
    } @else if (!error()) {
      <p class="muted">Loading…</p>
    }
  `,
})
export class CompanyEdition implements OnInit {
  readonly #api = inject(EditionsApi);

  protected readonly entitlements = signal<CompanyEntitlements | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly editionName = computed(() => EDITION_NAMES[this.entitlements()?.edition ?? 'community']);
  protected readonly included = computed(() => this.entitlements()?.features.filter((feature) => feature.enabled) ?? []);
  protected readonly unavailable = computed(
    () => this.entitlements()?.features.filter((feature) => !feature.enabled) ?? [],
  );

  async ngOnInit(): Promise<void> {
    try {
      this.entitlements.set(await this.#api.company());
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }
}
