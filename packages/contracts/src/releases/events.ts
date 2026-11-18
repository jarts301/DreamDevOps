import { z } from 'zod';
import { defineEvent, type EventOf } from '../event.ts';
import { commit, id, name } from '../fields.ts';
import { RELEASE_KINDS } from './http.ts';

/** Releases' events: Git Flow releases and hotfixes, from the branch to the published version. */

const release = { releaseId: id(), applicationId: id(), version: name() };

export const ReleaseStarted = defineEvent({
  type: 'ReleaseStarted',
  description: 'A release or hotfix starts',
  payload: z.object({ ...release, kind: z.enum(RELEASE_KINDS), branch: name() }),
  describe: (payload) => `Started the ${payload.kind} ${payload.version}`,
  summarize: (payload) => `The ${payload.kind} ${payload.version} started.`,
});

export const ReleaseCandidateCreated = defineEvent({
  type: 'ReleaseCandidateCreated',
  description: 'A release candidate is tagged',
  payload: z.object({ ...release, number: z.number().int().positive(), tag: name(), commit: commit() }),
  describe: (payload) => `Tagged release candidate ${payload.tag}`,
});

export const ReleaseMerged = defineEvent({
  type: 'ReleaseMerged',
  description: 'A release or hotfix merges into main',
  payload: z.object({ ...release, kind: z.enum(RELEASE_KINDS), mergeCommit: commit() }),
  describe: (payload) => `Merged the ${payload.kind} ${payload.version} into main`,
  summarize: (payload) => `The ${payload.kind} ${payload.version} merged into main.`,
});

export const ReleasePublished = defineEvent({
  type: 'ReleasePublished',
  description: "A release's final image is published",
  payload: z.object({ ...release, kind: z.enum(RELEASE_KINDS), buildId: id() }),
  describe: (payload) => `Published version ${payload.version}`,
  summarize: (payload) => `Version ${payload.version} is published.`,
});

export type ReleaseStarted = EventOf<typeof ReleaseStarted>;
export type ReleaseCandidateCreated = EventOf<typeof ReleaseCandidateCreated>;
export type ReleaseMerged = EventOf<typeof ReleaseMerged>;
export type ReleasePublished = EventOf<typeof ReleasePublished>;

export const RELEASES_EVENTS = [ReleaseStarted, ReleaseCandidateCreated, ReleaseMerged, ReleasePublished] as const;
