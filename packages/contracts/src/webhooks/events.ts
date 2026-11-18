import { z } from 'zod';
import { defineEvent, type EventOf, type PayloadOf } from '../event.ts';
import { commit, id, name } from '../fields.ts';

/**
 * What happened in an application's repository, as the webhook gateway learns it from
 * Git's signed webhooks. Each names the application whose repository it happened in.
 */

export const CodePushed = defineEvent({
  type: 'CodePushed',
  description: 'Code is pushed to a branch',
  payload: z.object({
    applicationId: id(),
    branch: name(),
    /** The branch's commit before the push, or null for a new branch. */
    before: commit().nullable(),
    after: commit(),
    commits: z.number().int().nonnegative(),
    /** The pusher's Git username, which is their user ID, never a name or an email. */
    pushedBy: z.string().nullable(),
  }),
  describe: (payload) => `Pushed ${payload.commits} commits to ${payload.branch}`,
});

export const BranchCreated = defineEvent({
  type: 'BranchCreated',
  description: 'A branch is created',
  payload: z.object({ applicationId: id(), branch: name(), commit: commit().nullable() }),
  describe: (payload) => `Created the branch ${payload.branch}`,
});

export const BranchDeleted = defineEvent({
  type: 'BranchDeleted',
  description: 'A branch is deleted',
  payload: z.object({ applicationId: id(), branch: name() }),
  describe: (payload) => `Deleted the branch ${payload.branch}`,
});

/** A pull request was opened or reopened, or got new commits, so its newest commit needs checking. */
export const PullRequestUpdated = defineEvent({
  type: 'PullRequestUpdated',
  description: 'A pull request is opened or gets new commits',
  payload: z.object({ applicationId: id(), number: z.number().int().positive(), head: name(), base: name(), headCommit: commit() }),
  describe: (payload) => `Updated pull request #${payload.number} from ${payload.head} into ${payload.base}`,
});

export const PullRequestMerged = defineEvent({
  type: 'PullRequestMerged',
  description: 'A pull request is merged',
  payload: z.object({ applicationId: id(), number: z.number().int().positive(), head: name(), base: name(), mergeCommit: commit() }),
  describe: (payload) => `Merged pull request #${payload.number} from ${payload.head} into ${payload.base}`,
});

export type CodePushed = EventOf<typeof CodePushed>;
export type BranchCreated = EventOf<typeof BranchCreated>;
export type BranchDeleted = EventOf<typeof BranchDeleted>;
export type PullRequestUpdated = EventOf<typeof PullRequestUpdated>;
export type PullRequestMerged = EventOf<typeof PullRequestMerged>;

/** A Git event as Git's webhook describes it, before the gateway has found the application it's about. */
export type GitChange =
  | { readonly eventType: 'CodePushed'; readonly payload: Omit<PayloadOf<typeof CodePushed>, 'applicationId'> }
  | { readonly eventType: 'BranchCreated'; readonly payload: Omit<PayloadOf<typeof BranchCreated>, 'applicationId'> }
  | { readonly eventType: 'BranchDeleted'; readonly payload: Omit<PayloadOf<typeof BranchDeleted>, 'applicationId'> }
  | { readonly eventType: 'PullRequestUpdated'; readonly payload: Omit<PayloadOf<typeof PullRequestUpdated>, 'applicationId'> }
  | { readonly eventType: 'PullRequestMerged'; readonly payload: Omit<PayloadOf<typeof PullRequestMerged>, 'applicationId'> };

export const WEBHOOKS_EVENTS = [CodePushed, BranchCreated, BranchDeleted, PullRequestUpdated, PullRequestMerged] as const;
