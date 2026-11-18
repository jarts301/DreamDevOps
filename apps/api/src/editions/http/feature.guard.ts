import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FEATURE_METADATA } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { Entitlements } from '../application/entitlements.ts';
import { EditionError } from '../domain/errors.ts';

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
