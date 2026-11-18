/** Small pieces of the sentences that describe events, shared by every context's contracts. */

/** The reason given for a change to production, at the end of a description, such as ', because "Broken release"'. */
export function because(reason: string | undefined): string {
  return reason === undefined || reason === '' ? '' : `, because "${reason}"`;
}
