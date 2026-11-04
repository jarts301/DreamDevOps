import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APP_CONFIG } from '../tokens.ts';
import type { AppConfig } from '../config/app-config.ts';
import { hashSessionId, SESSION_STORE, type SessionStore } from '../session/session-store.ts';
import { ACCESS_METADATA, type AccessRule } from './access.decorators.ts';
import { type ApiRequest, SESSION_COOKIE } from './request.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Finds the signed-in user from the session cookie. Deciding access is a later step. */
@Injectable()
export class SessionGuard implements CanActivate {
  readonly #store: SessionStore;
  readonly #config: AppConfig;

  constructor(@Inject(SESSION_STORE) store: SessionStore, @Inject(APP_CONFIG) config: AppConfig) {
    this.#store = store;
    this.#config = config;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ApiRequest>();
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId !== undefined) {
      const principal = await this.#store.touch(hashSessionId(sessionId), this.#config.sessionIdleMs);
      if (principal !== null) {
        request.principal = principal;
      }
    }
    return true;
  }
}

/**
 * Blocks cross-site request forgery. Browsers set Origin on state-changing requests,
 * and another site can't fake it, so anything from an unknown origin is refused.
 * A request with no Origin can't come from another site's page, so it's allowed.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  readonly #allowedOrigins: ReadonlySet<string>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.#allowedOrigins = new Set([new URL(config.publicUrl).origin, new URL(config.dashboardUrl).origin]);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ApiRequest>();
    const origin = request.headers.origin;
    if (SAFE_METHODS.has(request.method) || origin === undefined || this.#allowedOrigins.has(origin)) {
      return true;
    }
    throw new ForbiddenException('This request came from an origin that is not allowed.');
  }
}

/** Denies by default: a route with no declared access rule can't be called by anyone. */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  readonly #logger = new Logger(AuthorizationGuard.name);
  readonly #reflector: Reflector;

  constructor(@Inject(Reflector) reflector: Reflector) {
    this.#reflector = reflector;
  }

  canActivate(context: ExecutionContext): boolean {
    const rule = this.#reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (rule?.kind === 'public') {
      return true;
    }

    const { principal } = context.switchToHttp().getRequest<ApiRequest>();
    if (principal === undefined) {
      throw new UnauthorizedException('Sign in to continue.');
    }
    if (rule === undefined) {
      this.#logger.error(`${context.getClass().name}.${context.getHandler().name} has no access rule.`);
      throw new ForbiddenException('You do not have permission to do this.');
    }
    if (rule.kind === 'permissions' && !rule.permissions.every((p) => principal.permissions.includes(p))) {
      throw new ForbiddenException('You do not have permission to do this.');
    }
    return true;
  }
}
