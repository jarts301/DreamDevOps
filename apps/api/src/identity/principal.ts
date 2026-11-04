/** The signed-in user, as established by the server. */
export interface Principal {
  readonly subject: string;
  readonly displayName: string;
  /** The company this session acts for. Null for platform-level users. */
  readonly companyId: string | null;
  readonly permissions: readonly string[];
}
