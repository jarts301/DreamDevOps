import { z } from 'zod';
import { defineEvent, type EventOf } from '../event.ts';
import { id } from '../fields.ts';
import { roleName } from './roles.ts';

/**
 * Identity and access's events. Payloads hold IDs and roles, never email addresses or
 * invitation tokens, so the history and chat never show them.
 */

export const UserInvited = defineEvent({
  type: 'UserInvited',
  description: 'Someone is invited to the company',
  payload: z.object({ invitationId: id(), role: z.string(), invitedBy: id() }),
  describe: (payload) => `Invited someone as ${roleName(payload.role)}`,
  summarize: (payload) => `Someone was invited as ${roleName(payload.role)}.`,
});

/** Someone joined with an invitation, which it names, or a member's role changed, which it says from what. */
export const RoleGranted = defineEvent({
  type: 'RoleGranted',
  description: "Someone joins or a member's role changes",
  payload: z.object({
    userId: id(),
    role: z.string(),
    invitationId: id().optional(),
    previousRole: z.string().optional(),
    grantedBy: id().optional(),
  }),
  describe: (payload) =>
    payload.invitationId === undefined ? `Changed a member's role to ${roleName(payload.role)}` : `Joined as ${roleName(payload.role)}`,
  summarize: (payload) =>
    payload.invitationId === undefined
      ? `A member's role changed to ${roleName(payload.role)}.`
      : `Someone joined as ${roleName(payload.role)}.`,
});

export const MemberRemoved = defineEvent({
  type: 'MemberRemoved',
  description: 'A member is removed',
  payload: z.object({ userId: id(), role: z.string(), removedBy: id() }),
  describe: (payload) => `Removed a member who was ${roleName(payload.role)}`,
  summarize: () => 'A member was removed.',
});

export const InvitationRevoked = defineEvent({
  type: 'InvitationRevoked',
  description: 'An invitation is revoked',
  payload: z.object({ invitationId: id(), revokedBy: id() }),
  describe: () => 'Revoked an invitation',
  summarize: () => 'An invitation was revoked.',
});

export type UserInvited = EventOf<typeof UserInvited>;
export type RoleGranted = EventOf<typeof RoleGranted>;
export type MemberRemoved = EventOf<typeof MemberRemoved>;
export type InvitationRevoked = EventOf<typeof InvitationRevoked>;

export const IDENTITY_ACCESS_EVENTS = [UserInvited, RoleGranted, MemberRemoved, InvitationRevoked] as const;
