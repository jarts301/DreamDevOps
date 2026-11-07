import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiRequest } from '../../http/request.ts';
import { Entitlements } from '../application/entitlements.ts';
import { EditionError } from '../domain/errors.ts';
import { isFeatureKey } from '../domain/features.ts';

const FEATURE_METADATA = 'dreamdevops:feature';

/**
 * Only companies that have this feature may call the route. Use it alongside an
 * access rule, which still decides who in the company may call it.
 */
export const RequireFeature = (key: string) => {
  if (!isFeatureKey(key)) {
    throw new Error(`Unknown feature "${key}". Add it to the feature catalog first.`);
  }
  return SetMetadata(FEATURE_METADATA, key);
};

/** Runs after the access check, so only signed-in users with permission reach the database here. */
@Injectable()
export class FeatureGuard implements CanActivate {
  readonly #reflector: Reflector;
  readonly #entitlements: Entitlements;

  constructor(@Inject(Reflector) reflector: Reflector, @Inject(Entitlements) entitlements: Entitlements) {
    this.#reflector = reflector;
    this.#entitlements = entitlements;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.#reflector.getAllAndOverride<string | undefined>(FEATURE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (feature === undefined) {
      return true;
    }
    const companyId = context.switchToHttp().getRequest<ApiRequest>().principal?.companyId ?? null;
    if (companyId === null || !(await this.#entitlements.isEnabled(companyId, feature))) {
      throw new EditionError('not-entitled', "Your company's edition doesn't include this feature.");
    }
    return true;
  }
}
