/** Messages from other tools are cut to this length, because people see them. */
export const MAX_ERROR_DESCRIPTION_LENGTH = 300;

/**
 * A short description of a failure, such as from another tool, for showing to people
 * and storing beside what failed. Anything that isn't an Error says only that it failed.
 */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return message.slice(0, MAX_ERROR_DESCRIPTION_LENGTH);
}
