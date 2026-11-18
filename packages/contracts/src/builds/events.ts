import { z } from 'zod';
import { defineEvent, type EventOf } from '../event.ts';
import { commit, id, name } from '../fields.ts';
import { BUILD_KINDS } from './http.ts';

/** Builds' events: each image, from its request to its signed result. */

const build = {
  buildId: id(),
  applicationId: id(),
  kind: z.enum(BUILD_KINDS),
  /** The branch it builds, if any. A release's final image builds a tag's commit. */
  branch: name().nullable(),
  commit: commit(),
  /** The image's tag, such as 1.4.0-rc.2. */
  tag: name(),
  /** The version it's for, such as 1.4.0, for release candidates and final images. */
  version: name().nullable(),
};

export const BuildRequested = defineEvent({
  type: 'BuildRequested',
  description: 'An image is asked for',
  payload: z.object(build),
  describe: (payload) => `Asked for the image ${payload.tag}`,
});

/** Checked, scanned and, unless it's a check, stored and signed. */
export const BuildSucceeded = defineEvent({
  type: 'BuildSucceeded',
  description: 'An image is built, scanned and signed',
  payload: z.object({
    ...build,
    releaseId: id().nullable(),
    /** Where the image is, such as registry.example.com/acme/billing-api:1.4.0. A check has none. */
    imageRef: z.string().nullable(),
    digest: z.string().nullable(),
    /** The company's key that signed it: the test key, or the release key for final images. */
    signedWith: z.enum(['test', 'release']).nullable(),
  }),
  describe: (payload) => `Built, scanned and signed the image ${payload.tag}`,
  summarize: (payload) => `The ${payload.kind} image ${payload.tag} is ready and signed.`,
});

export const BuildFailed = defineEvent({
  type: 'BuildFailed',
  description: 'An image build fails',
  payload: z.object({ ...build, releaseId: id().nullable(), reason: z.string().nullable() }),
  describe: (payload) => `The image ${payload.tag} failed: ${payload.reason ?? 'unknown reason'}`,
  summarize: (payload) => `The ${payload.kind} image ${payload.tag} failed: ${payload.reason ?? 'unknown reason'}`,
});

/** A deleted branch's feature image, which nothing should deploy any more. */
export const FeatureImageDeleted = defineEvent({
  type: 'FeatureImageDeleted',
  description: "A deleted branch's feature image is deleted",
  payload: z.object({ buildId: id(), applicationId: id(), branch: name(), tag: name() }),
  describe: (payload) => `Deleted the feature image ${payload.tag}`,
});

export type BuildRequested = EventOf<typeof BuildRequested>;
export type BuildSucceeded = EventOf<typeof BuildSucceeded>;
export type BuildFailed = EventOf<typeof BuildFailed>;
export type FeatureImageDeleted = EventOf<typeof FeatureImageDeleted>;

export const BUILDS_EVENTS = [BuildRequested, BuildSucceeded, BuildFailed, FeatureImageDeleted] as const;
