import { isFeatureKey } from '@dreamdevops/contracts/editions/features';
import { type ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const ACCESS_METADATA = 'dreamdevops:access';

export type AccessRule =
  | { readonly kind: 'public' }
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'permissions'; readonly permissions: readonly string[] };

/** Anyone may call this route. */
export const Public = () => SetMetadata<string, AccessRule>(ACCESS_METADATA, { kind: 'public' });

/** Any signed-in user may call this route. */
export const Authenticated = () => SetMetadata<string, AccessRule>(ACCESS_METADATA, { kind: 'authenticated' });

/** Only signed-in users with every listed permission may call this route. */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata<string, AccessRule>(ACCESS_METADATA, { kind: 'permissions', permissions });

export const FEATURE_METADATA = 'dreamdevops:feature';

/**
 * Only companies whose edition includes this feature may call the route. Use it alongside
 * an access rule, which still decides who in the company may call it. Editions' guard
 * checks it on every request.
 */
export const RequireFeature = (key: string) => {
  if (!isFeatureKey(key)) {
    throw new Error(`Unknown feature "${key}". Add it to the feature catalog first.`);
  }
  return SetMetadata(FEATURE_METADATA, key);
};

const SIGN_IN_METADATA = 'dreamdevops:sign-in';

/**
 * A route that signs someone in or proves who they are, such as logging in, accepting an
 * invitation, or an agent getting a token. These share the stricter sign-in rate limit.
 */
export const SignInRateLimit = () => SetMetadata(SIGN_IN_METADATA, true);

const reflector = new Reflector();

/** Whether a request is to a route marked with SignInRateLimit, on itself or its controller. */
export function isSignInRoute(context: ExecutionContext): boolean {
  return reflector.getAllAndOverride<boolean | undefined>(SIGN_IN_METADATA, [context.getHandler(), context.getClass()]) === true;
}
