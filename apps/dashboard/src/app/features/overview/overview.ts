import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { companyLabel, permissionDescription, roleName } from '../../core/labels';
import { SessionService } from '../../core/session.service';

@Component({
  selector: 'app-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Welcome, {{ session.user()?.displayName }}</h1>

    @if (session.user(); as user) {
      @if (user.companyId) {
        <p class="lead">
          You're working in {{ companyLabel({ companyId: user.companyId, companyName: user.companyName }) }}. Your role
          is {{ roleName(user.role) }}.
        </p>
      } @else if (session.isPlatformUser()) {
        <p class="lead">You're a Platform Admin. You can create and manage companies, but you can't see their data.</p>
      } @else {
        <div class="empty-state">
          <h2>You're not in an active company</h2>
          <p>Ask a Company Admin to send you an invitation, then open its link to join.</p>
          <p class="muted">If your company was suspended, you get access back once it's reactivated.</p>
        </div>
      }
    }

    @if (abilities().length > 0) {
      <section class="card" aria-labelledby="abilities-heading">
        <h2 id="abilities-heading">What you can do</h2>
        <ul class="ability-list">
          @for (ability of abilities(); track ability) {
            <li>{{ ability }}</li>
          }
        </ul>
      </section>
    }
  `,
})
export class Overview {
  protected readonly session = inject(SessionService);
  protected readonly companyLabel = companyLabel;
  protected readonly roleName = roleName;
  protected readonly abilities = computed(() =>
    (this.session.user()?.permissions ?? []).map(permissionDescription),
  );
}
