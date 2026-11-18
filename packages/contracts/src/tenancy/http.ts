import type { SentInvitation } from '../identity-access/http.ts';

/** Tenancy's HTTP API, as the dashboard sees it. Types only, so a browser app can use them. */

export type CompanyStatus = 'provisioning' | 'active' | 'provisioning-failed' | 'suspended';

/** A company in the platform's register. Platform admins see names and states, never company data. */
export interface CompanySummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: CompanyStatus;
  readonly createdAt: string;
  /** Why provisioning its resources failed, while it has. */
  readonly provisioningError: string | null;
}

/** Creates a company, and invites its first admin. */
export interface CreateCompany {
  readonly name: string;
  readonly firstAdminEmail: string;
}

export interface RenameCompany {
  readonly name: string;
}

/** Invites a company's first admin again, such as when the first invitation was lost. */
export interface InviteFirstAdmin {
  readonly email: string;
}

/** A company just made, with the invitation for its first admin. */
export interface CreatedCompany {
  readonly company: CompanySummary;
  readonly invitation: SentInvitation;
}
