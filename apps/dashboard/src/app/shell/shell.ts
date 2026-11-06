import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { errorMessage } from '../core/api-error';
import { BrowserNavigation } from '../core/browser-navigation';
import { roleName } from '../core/labels';
import { SessionService } from '../core/session.service';

interface NavigationItem {
  readonly path: string;
  readonly label: string;
  readonly permission?: string;
}

// Feature areas mirror the backend's contexts. Each new module adds its screens here.
const NAVIGATION: readonly NavigationItem[] = [
  { path: '/', label: 'Overview' },
  { path: '/team', label: 'Team', permission: 'company-users:manage' },
  { path: '/platform/companies', label: 'Companies', permission: 'companies:manage' },
];

@Component({
  selector: 'app-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="skip-link" href="#main">Skip to content</a>
    <div class="shell">
      <header class="shell-sidebar">
        <p class="brand">DreamDevOps</p>
        <nav aria-label="Main">
          <ul class="nav-list">
            @for (item of navigation(); track item.path) {
              <li>
                <a
                  class="nav-link"
                  [routerLink]="item.path"
                  routerLinkActive="nav-link-active"
                  ariaCurrentWhenActive="page"
                  [routerLinkActiveOptions]="{ exact: item.path === '/' }"
                  >{{ item.label }}</a
                >
              </li>
            }
          </ul>
        </nav>
      </header>

      <div class="shell-body">
        <div class="topbar">
          <div class="topbar-company">
            @if (memberships().length > 1) {
              <label class="field-inline">
                <span>Company</span>
                <select [value]="session.user()?.companyId" (change)="chooseCompany($event)">
                  @for (membership of memberships(); track membership.companyId) {
                    <option [value]="membership.companyId" [selected]="membership.companyId === session.user()?.companyId">
                      {{ membership.companyName }} ({{ roleName(membership.role) }})
                    </option>
                  }
                </select>
              </label>
            } @else if (session.user()?.companyName; as companyName) {
              <span>{{ companyName }} · {{ roleName(session.user()?.role ?? null) }}</span>
            } @else {
              <span class="muted">No company</span>
            }
          </div>
          <div class="topbar-user">
            <span class="muted">{{ session.user()?.displayName }}</span>
            <button type="button" class="button" (click)="signOut()" [disabled]="signingOut()">Sign out</button>
          </div>
        </div>

        @if (error(); as message) {
          <p class="alert alert-error" role="alert">{{ message }}</p>
        }

        <main id="main" class="content" tabindex="-1">
          <router-outlet />
        </main>
      </div>
    </div>
  `,
})
export class Shell {
  readonly #navigation = inject(BrowserNavigation);
  protected readonly session = inject(SessionService);
  protected readonly error = signal<string | null>(null);
  protected readonly signingOut = signal(false);
  protected readonly roleName = roleName;

  protected readonly memberships = computed(() => this.session.user()?.memberships ?? []);
  protected readonly navigation = computed(() => {
    // Reading the user here keeps the menu current after switching company.
    this.session.user();
    return NAVIGATION.filter((item) => item.permission === undefined || this.session.can(item.permission));
  });

  protected async chooseCompany(event: Event): Promise<void> {
    this.error.set(null);
    try {
      await this.session.chooseCompany((event.target as HTMLSelectElement).value);
      // A full reload clears anything on screen from the previous company.
      this.#navigation.go('/');
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  protected async signOut(): Promise<void> {
    this.error.set(null);
    this.signingOut.set(true);
    try {
      await this.session.signOut();
    } catch (error) {
      this.error.set(errorMessage(error));
      this.signingOut.set(false);
    }
  }
}
