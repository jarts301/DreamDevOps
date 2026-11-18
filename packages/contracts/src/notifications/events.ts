import { z } from 'zod';
import { defineEvent, type EventOf } from '../event.ts';

/** Notifications' events. */

/** A sample message sent to check a chat rule's address. It's only sent, never saved, so the history never shows it. */
export const NotificationTest = defineEvent({
  type: 'NotificationTest',
  description: 'A test message is sent',
  payload: z.object({}),
  describe: () => 'Sent a test message',
  summarize: () => 'This is a test message from DreamDevOps.',
});

export type NotificationTest = EventOf<typeof NotificationTest>;

export const NOTIFICATIONS_EVENTS = [NotificationTest] as const;
