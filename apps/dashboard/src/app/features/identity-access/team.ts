import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { PageActivity } from '../../core/page-activity';
import { roleName } from '../../core/labels';
import { SessionService } from '../../core/session.service';
import {
  type CreatedInvitation,
  IdentityAccessApi,
  type Invitation,
  type Member,
  type Role,
} from './identity-access.api';
import { InvitationResult } from './invitation-result';

@Component({
  selector: 'app-team',
  imports: [DatePipe, InvitationResult, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Team</h1>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }

    <section class="card" aria-labelledby="invite-heading">
      <h2 id="invite-heading">Invite someone</h2>
      <form class="form-row" [formGroup]="inviteForm" (ngSubmit)="invite()">
        <label class="field">
          <span>Email</span>
          <input type="email" formControlName="email" autocomplete="off" required />
        </label>
        <label class="field">
          <span>Role</span>
          <select formControlName="role" required>
            @for (role of roles(); track role.key) {
              <option [value]="role.key">{{ role.name }}</option>
            }
          </select>
        </label>
        <button type="submit" class="button button-primary" [disabled]="inviteForm.invalid || working()">
          Create invitation
        </button>
      </form>
      @if (created(); as result) {
        <app-invitation-result [invitation]="result.invitation" [email]="result.email" />
      }
    </section>

    <section class="card" aria-labelledby="members-heading">
      <h2 id="members-heading">Members</h2>
      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Joined</th>
                <th scope="col"><span class="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (member of members(); track member.userId) {
                <tr>
                  <td>
                    {{ member.displayName }}
                    @if (member.userId === currentUserId()) {
                      <span class="muted">(you)</span>
                    }
                  </td>
                  <td>{{ member.email }}</td>
                  <td>
                    <select
                      [attr.aria-label]="'Role of ' + member.displayName"
                      [disabled]="working()"
                      (change)="changeRole(member, $event)"
                    >
                      @for (role of roles(); track role.key) {
                        <option [value]="role.key" [selected]="role.key === member.role">{{ role.name }}</option>
                      }
                    </select>
                  </td>
                  <td>{{ member.joinedAt | date: 'mediumDate' }}</td>
                  <td class="cell-actions">
                    @if (removing() === member.userId) {
                      <button type="button" class="button button-danger" [disabled]="working()" (click)="remove(member)">
                        Confirm removal
                      </button>
                      <button type="button" class="button" (click)="removing.set(null)">Cancel</button>
                    } @else {
                      <button
                        type="button"
                        class="button"
                        [attr.aria-label]="'Remove ' + member.displayName"
                        (click)="removing.set(member.userId)"
                      >
                        Remove
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>

    <section class="card" aria-labelledby="invitations-heading">
      <h2 id="invitations-heading">Open invitations</h2>
      @if (invitations().length === 0) {
        <p class="muted">No open invitations.</p>
      } @else {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Expires</th>
                <th scope="col"><span class="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (invitation of invitations(); track invitation.id) {
                <tr>
                  <td>{{ invitation.email }}</td>
                  <td>{{ roleName(invitation.role) }}</td>
                  <td>{{ invitation.expiresAt | date: 'mediumDate' }}</td>
                  <td class="cell-actions">
                    <button
                      type="button"
                      class="button"
                      [attr.aria-label]="'Revoke invitation for ' + invitation.email"
                      [disabled]="working()"
                      (click)="revoke(invitation)"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
})
export class Team implements OnInit {
  readonly #api = inject(IdentityAccessApi);
  readonly #session = inject(SessionService);
  readonly #forms = inject(NonNullableFormBuilder);

  protected readonly roleName = roleName;
  protected readonly roles = signal<Role[]>([]);
  protected readonly members = signal<Member[]>([]);
  protected readonly invitations = signal<Invitation[]>([]);
  protected readonly loading = signal(true);
  readonly #activity = new PageActivity('no-notice');
  protected readonly working = this.#activity.working;
  protected readonly error = this.#activity.error;
  protected readonly removing = signal<string | null>(null);
  protected readonly created = signal<{ invitation: CreatedInvitation; email: string } | null>(null);
  protected readonly currentUserId = computed(() => this.#session.user()?.userId);

  protected readonly inviteForm = this.#forms.group({
    email: ['', [Validators.required, Validators.email]],
    role: ['developer', Validators.required],
  });

  async ngOnInit(): Promise<void> {
    await this.#activity.run(async () => {
      this.roles.set(await this.#api.roles());
      await this.#refresh();
    });
    this.loading.set(false);
  }

  protected async invite(): Promise<void> {
    const { email, role } = this.inviteForm.getRawValue();
    this.created.set(null);
    await this.#activity.run(async () => {
      const invitation = await this.#api.invite(email, role);
      this.created.set({ invitation, email });
      this.inviteForm.reset();
      await this.#refresh();
    });
  }

  protected async changeRole(member: Member, event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    const succeeded = await this.#activity.run(async () => {
      await this.#api.changeRole(member.userId, select.value);
      await this.#refresh();
      if (member.userId === this.currentUserId()) {
        await this.#session.load({ refresh: true });
      }
    });
    if (!succeeded) {
      // The server kept the old role, so the screen must show it again.
      select.value = member.role;
    }
  }

  protected async remove(member: Member): Promise<void> {
    await this.#activity.run(async () => {
      await this.#api.removeMember(member.userId);
      this.removing.set(null);
      await this.#refresh();
    });
  }

  protected async revoke(invitation: Invitation): Promise<void> {
    await this.#activity.run(async () => {
      await this.#api.revokeInvitation(invitation.id);
      await this.#refresh();
    });
  }

  async #refresh(): Promise<void> {
    const [members, invitations] = await Promise.all([this.#api.members(), this.#api.invitations()]);
    this.members.set(members);
    this.invitations.set(invitations);
  }
}
