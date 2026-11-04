import { SetMetadata } from '@nestjs/common';

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
