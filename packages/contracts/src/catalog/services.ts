import type { ApplicationView } from './http.ts';

/** What the application catalog answers for other contexts. */

export const APPLICATION_DIRECTORY = Symbol('APPLICATION_DIRECTORY');

/** The current company's applications. Another company's are never found. */
export interface ApplicationDirectory {
  /** One application, active or archived. Throws a not-found error if the company has none with this ID. */
  get(applicationId: unknown): Promise<ApplicationView>;
  /** The IDs of the applications with these short names, active or archived, by short name. Others are left out. */
  idsBySlug(slugs: readonly string[]): Promise<Map<string, string>>;
}
