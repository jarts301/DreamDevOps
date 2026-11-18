/** Source governance's HTTP API, as the dashboard sees it. Types only, so a browser app can use them. */

export type RepositoryStatus = 'creating' | 'ready' | 'failed';

/** An application's repository, as it's being made or once it's ready. */
export interface RepositoryView {
  readonly applicationId: string;
  readonly status: RepositoryStatus;
  /** Such as "acme/billing-api". */
  readonly fullName: string;
  /** Where people see it in the browser. */
  readonly url: string;
  /** The blueprint version it started from. */
  readonly blueprint: { readonly key: string; readonly version: string } | null;
  readonly lastError: string | null;
}

/** The Git team a member is in, which follows from their role. */
export type TeamKey = 'developers' | 'tech-leads' | 'readers';

/** A member's own access to the company's Git. */
export interface SourceAccessView {
  /** Where to sign in to Forgejo, which creates the account on first use. */
  readonly signInUrl: string;
  readonly gitUrl: string;
  readonly hasAccount: boolean;
  readonly team: TeamKey;
}
