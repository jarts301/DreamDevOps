import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, type OnInit, signal } from '@angular/core';
import { PageActivity } from '../../core/page-activity';
import { type CompanyEditionRow, type Edition, EDITION_NAMES, EditionsApi, type EditionsOverview } from './editions.api';

/** Each company's edition. Platform admins see names and editions, never company data. */
@Component({
  selector: 'app-platform-editions',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Editions</h1>
    <p class="lead">Choose which edition each company uses.</p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }
    @if (notice(); as message) {
      <p class="alert alert-success" role="status">{{ message }}</p>
    }

    @if (data(); as current) {
      <section class="card" aria-labelledby="license-heading">
        <h2 id="license-heading">This server</h2>
        @if (current.provider.commercialAvailable) {
          <p>Commercial features are installed: {{ current.provider.name }}.</p>
        } @else {
          <p>
            Only the Community Edition is installed, so every company uses it. Installing the Commercial Edition lets
            you move companies to it.
          </p>
        }
        @if (current.provider.detail; as detail) {
          <p class="muted">{{ detail }}</p>
        }
      </section>

      <section class="card" aria-labelledby="companies-heading">
        <h2 id="companies-heading">Companies</h2>
        @if (current.companies.length === 0) {
          <p class="muted">No companies yet.</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Company</th>
                  <th scope="col">Edition</th>
                  <th scope="col">Last changed</th>
                </tr>
              </thead>
              <tbody>
                @for (company of current.companies; track company.companyId) {
                  <tr>
                    <td>{{ company.companyName }}</td>
                    <td>
                      <select
                        [attr.aria-label]="'Edition of ' + company.companyName"
                        [disabled]="working() || !current.provider.commercialAvailable"
                        (change)="choose(company, $event)"
                      >
                        @for (edition of editions; track edition) {
                          <option [value]="edition" [selected]="edition === company.edition">
                            {{ editionName(edition) }}
                          </option>
                        }
                      </select>
                    </td>
                    <td>
                      @if (company.changedAt; as changedAt) {
                        {{ changedAt | date: 'mediumDate' }}
                      } @else {
                        <span class="muted">Never</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    } @else if (!error()) {
      <p class="muted">Loading…</p>
    }
  `,
})
export class PlatformEditions implements OnInit {
  readonly #api = inject(EditionsApi);

  protected readonly editions: readonly Edition[] = ['community', 'commercial'];
  protected readonly data = signal<EditionsOverview | null>(null);
  readonly #activity = new PageActivity('clear-when-starting');
  protected readonly working = this.#activity.working;
  protected readonly error = this.#activity.error;
  protected readonly notice = this.#activity.notice;

  async ngOnInit(): Promise<void> {
    await this.#activity.run(() => this.#refresh());
  }

  protected editionName(edition: Edition): string {
    return EDITION_NAMES[edition];
  }

  protected async choose(company: CompanyEditionRow, event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    const edition = select.value as Edition;
    await this.#activity.run(async () => {
      try {
        await this.#api.setEdition(company.companyId, edition);
        this.notice.set(`${company.companyName} now uses the ${EDITION_NAMES[edition]} Edition.`);
      } catch (error) {
        // The list's data doesn't change after a refusal, so the choice is put back here.
        select.value = company.edition;
        throw error;
      } finally {
        await this.#refresh();
      }
    });
  }

  async #refresh(): Promise<void> {
    this.data.set(await this.#api.platform());
  }
}
