import { isUuid } from '@dreamdevops/shared-kernel';
import { z } from 'zod';

/**
 * The kinds of fields contracts are made of, so every context writes an ID, a commit or a
 * time the same way.
 */

/** An ID, which is always a UUID. */
export const id = () => z.string().refine(isUuid, 'Expected a UUID.');

/** A name people gave something, or one the platform made, such as a slug. */
export const name = () => z.string().min(1);

/** A Git commit, by its full hash. */
export const commit = () => z.string().regex(/^[0-9a-f]{40,64}$/, 'Expected a full commit hash.');

/** A moment, as an ISO 8601 timestamp. */
export const timestamp = () => z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Expected an ISO 8601 time.');

/** Why someone made a change to production, which production's protection asks for. */
export const reason = () => z.string().min(1).optional();
