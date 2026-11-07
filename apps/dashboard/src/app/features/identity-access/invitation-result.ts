import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { type CreatedInvitation, invitationLink } from './identity-access.api';

/** Shows a new invitation's link. The API can't show it again, because it keeps only a hash. */
@Component({
  selector: 'app-invitation-result',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="alert alert-success" role="status">
      <p><strong>Invitation created for {{ email() }}.</strong></p>
      @if (invitation().emailSent) {
        <p>We emailed them the link. You can also send it yourself.</p>
      } @else if (invitation().emailSent === false) {
        <p>We couldn't email them, so send them this link yourself.</p>
      }
      <p>
        The link is shown only once, can be used once, and expires on
        {{ invitation().expiresAt | date: 'mediumDate' }}.
      </p>
      <div class="copy-row">
        <input type="text" readonly aria-label="Invitation link" [value]="link()" />
        <button type="button" class="button" (click)="copy()">{{ copied() ? 'Copied' : 'Copy' }}</button>
      </div>
    </div>
  `,
})
export class InvitationResult {
  readonly invitation = input.required<CreatedInvitation>();
  readonly email = input.required<string>();
  protected readonly copied = signal(false);
  protected readonly link = computed(() => invitationLink(this.invitation().token));

  protected async copy(): Promise<void> {
    await navigator.clipboard.writeText(this.link());
    this.copied.set(true);
  }
}
