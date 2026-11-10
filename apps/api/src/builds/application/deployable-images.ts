import type { Check } from '../../shared/progress.ts';

/** Provides DeployableImages to other contexts. */
export const DEPLOYABLE_IMAGES = Symbol('DEPLOYABLE_IMAGES');

export type ImageKind = 'development' | 'release-candidate' | 'hotfix-candidate' | 'release';

/** An image that was built, published, signed and verified, so it can be deployed. */
export interface DeployableImage {
  readonly buildId: string;
  readonly applicationId: string;
  readonly kind: ImageKind;
  readonly version: string;
  /**
   * Whether it's fit for production. Only releases are: merged into main, tagged, and
   * checked as what main holds. Production environments run nothing else.
   */
  readonly productive: boolean;
  /** Where it lives, without a tag, such as localhost:3000/acme/billing-api. */
  readonly repository: string;
  /** Deployments use the digest, never the tag, so they run exactly what was signed. */
  readonly digest: string;
  readonly commit: string;
  readonly builtAt: string;
}

export interface SignatureVerification {
  /** Whether a signature made with the platform's key covers this exact image. */
  readonly valid: boolean;
  readonly checks: readonly Check[];
}

/**
 * What Builds offers the contexts that run images: the images each application can
 * deploy, and a check of their signatures against the platform's key.
 */
export interface DeployableImages {
  /** An application's deployable images, newest first. */
  list(applicationId: string): Promise<DeployableImage[]>;
  /** One image, or null if there's no such build, or it didn't finish and publish. */
  find(buildId: string): Promise<DeployableImage | null>;
  /** Reads the image's signatures from the registry, and checks them against the platform's key. */
  verify(image: { readonly repository: string; readonly digest: string }): Promise<SignatureVerification>;
}
