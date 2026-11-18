import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  AcceptedInvitation,
  InvitationView,
  MemberView,
  RoleView,
  SentInvitation,
} from '@dreamdevops/contracts/identity-access/http';

// The API's answers are Identity and access's HTTP contract, under the names the pages use.
export type Role = RoleView;
export type Member = MemberView;
export type Invitation = InvitationView;
/** An invitation just made, with whether the API emailed its link. */
export type CreatedInvitation = SentInvitation;

/** The fragment never reaches a server, so the token stays out of server and proxy logs. */
export function invitationLink(token: string): string {
  return `${location.origin}/invitations/accept#token=${encodeURIComponent(token)}`;
}

@Injectable({ providedIn: 'root' })
export class IdentityAccessApi {
  readonly #http = inject(HttpClient);

  roles(): Promise<Role[]> {
    return firstValueFrom(this.#http.get<Role[]>('/api/v1/company/roles'));
  }

  members(): Promise<Member[]> {
    return firstValueFrom(this.#http.get<Member[]>('/api/v1/company/members'));
  }

  changeRole(userId: string, role: string): Promise<unknown> {
    return firstValueFrom(this.#http.patch(`/api/v1/company/members/${encodeURIComponent(userId)}`, { role }));
  }

  removeMember(userId: string): Promise<unknown> {
    return firstValueFrom(this.#http.delete(`/api/v1/company/members/${encodeURIComponent(userId)}`));
  }

  invitations(): Promise<Invitation[]> {
    return firstValueFrom(this.#http.get<Invitation[]>('/api/v1/company/invitations'));
  }

  invite(email: string, role: string): Promise<CreatedInvitation> {
    return firstValueFrom(this.#http.post<CreatedInvitation>('/api/v1/company/invitations', { email, role }));
  }

  revokeInvitation(id: string): Promise<unknown> {
    return firstValueFrom(this.#http.delete(`/api/v1/company/invitations/${encodeURIComponent(id)}`));
  }

  acceptInvitation(token: string): Promise<AcceptedInvitation> {
    return firstValueFrom(this.#http.post<AcceptedInvitation>('/api/v1/invitations/accept', { token }));
  }
}
