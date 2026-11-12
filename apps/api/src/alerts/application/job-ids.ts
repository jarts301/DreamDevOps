import { createHash } from 'node:crypto';

/**
 * A job ID made from what the job is about, such as an event and a member, so the same
 * job is queued once even if it's asked for twice. Job IDs must be UUIDs, so this derives
 * one, in the shape of a version 5 UUID.
 */
export function jobIdFor(...parts: readonly string[]): string {
  const hex = createHash('sha256').update(parts.join(':')).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
