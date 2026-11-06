import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface Role {
  readonly key: string;
  readonly name: string;
}

export interface Member {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
  readonly joinedAt: string;
}

export interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly expiresAt: string;
}

export interface CreatedInvitation {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
}

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

  acceptInvitation(token: string): Promise<{ companyId: string; role: string }> {
    return firstValueFrom(this.#http.post<{ companyId: string; role: string }>('/api/v1/invitations/accept', { token }));
  }
}
