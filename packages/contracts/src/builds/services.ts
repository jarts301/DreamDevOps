import type { BuildKind, BuildStatus, Check, SigningPurpose } from './http.ts';

/** What Builds answers for other contexts: asking for images, and the images deployments can run. */

/** What a build is asked for. */
export interface BuildRequest {
  readonly applicationId: string;
  readonly kind: BuildKind;
  readonly branch: string | null;
  readonly commit: string;
  readonly tag: string;
  readonly version: string | null;
  readonly releaseId: string | null;
  /** Who asked, or null when the platform did, such as for a release candidate. */
  readonly actorId: string | null;
}

export const BUILD_REQUESTS = Symbol('BUILD_REQUESTS');

/** Asks for images, such as a release's candidates and final image, and follows them. */
export interface BuildRequests {
  /**
   * Asks for a build, and returns its ID. An image tag already being built or built is
   * reused, so repeated events don't build twice.
   */
  request(input: BuildRequest): Promise<string>;
  /** Each build's status, by its ID. Unknown builds are left out. */
  statuses(buildIds: readonly string[]): Promise<Map<string, BuildStatus>>;
}

/** A version of an application, as Deployments needs it: what to run, and whether it may. */
export interface DeployableImage {
  readonly id: string;
  readonly applicationId: string;
  readonly kind: BuildKind;
  readonly tag: string;
  readonly version: string | null;
  readonly status: BuildStatus;
  /** Where the image is, such as registry.example.com/acme/billing-api:1.4.0, once it's stored. */
  readonly imageRef: string | null;
  readonly digest: string | null;
}

/** One check of an image's signature, such as "The image is signed", and how it went. */
export type SignatureCheck = Check;

export const DEPLOYABLE_IMAGES = Symbol('DEPLOYABLE_IMAGES');

/** The images Deployments may run, in the current company. */
export interface DeployableImages {
  /** The images with these build IDs, by ID. Unknown ones are left out. */
  many(buildIds: readonly string[]): Promise<ReadonlyMap<string, DeployableImage>>;
  /**
   * Reads an image's signature back from the registry and checks it with the company's key,
   * as a target would, for runtimes the platform drives itself, such as This machine.
   */
  checkSignature(buildId: string): Promise<{ readonly checks: readonly SignatureCheck[] }>;
}

export const IMAGE_SIGNING_KEYS = Symbol('IMAGE_SIGNING_KEYS');

/** The current company's public signing keys, which targets check images with. */
export interface ImageSigningKeys {
  /** The public key, in PEM, for a purpose. The company's keys are made on first use. */
  publicKey(purpose: SigningPurpose): Promise<string>;
}
