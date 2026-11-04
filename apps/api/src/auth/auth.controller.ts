import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { CookieOptions, Response } from 'express';
import { APP_CONFIG } from '../tokens.ts';
import type { AppConfig } from '../config/app-config.ts';
import { IDENTITY_PROVIDER, type IdentityProvider } from '../identity/identity-provider.ts';
import { hashSessionId, newSessionId, SESSION_STORE, type SessionStore } from '../session/session-store.ts';
import { Authenticated, Public } from '../http/access.decorators.ts';
import { type ApiRequest, LOGIN_COOKIE, SESSION_COOKIE } from '../http/request.ts';

const LOGIN_COOKIE_LIFETIME_MS = 10 * 60_000;

/**
 * The backend for frontend's login. Tokens from the login provider stay on the server,
 * and the browser only holds an opaque session ID that scripts can't read.
 */
@Controller('auth')
export class AuthController {
  readonly #config: AppConfig;
  readonly #identityProvider: IdentityProvider;
  readonly #sessions: SessionStore;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(IDENTITY_PROVIDER) identityProvider: IdentityProvider,
    @Inject(SESSION_STORE) sessions: SessionStore,
  ) {
    this.#config = config;
    this.#identityProvider = identityProvider;
    this.#sessions = sessions;
  }

  @Public()
  @Get('login')
  login(@Query('as') loginHint: unknown, @Res() response: Response): void {
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');

    response.cookie(LOGIN_COOKIE, `${state}.${codeVerifier}`, this.#cookieOptions(LOGIN_COOKIE_LIFETIME_MS));
    response.redirect(
      302,
      this.#identityProvider.authorizationUrl({
        state,
        codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
        redirectUri: this.#callbackUrl(),
        ...(typeof loginHint === 'string' && { loginHint }),
      }),
    );
  }

  @Public()
  @Get('callback')
  async callback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Req() request: ApiRequest,
    @Res() response: Response,
  ): Promise<void> {
    const [expectedState, codeVerifier] = (request.cookies[LOGIN_COOKIE] ?? '').split('.');
    response.clearCookie(LOGIN_COOKIE, this.#cookieOptions());

    if (typeof code !== 'string' || typeof state !== 'string' || !expectedState || !codeVerifier) {
      throw new BadRequestException('This login attempt is not valid. Start again.');
    }
    if (!sameText(state, expectedState)) {
      throw new BadRequestException('This login attempt is not valid. Start again.');
    }

    const principal = await this.#identityProvider.exchangeCode({
      code,
      codeVerifier,
      redirectUri: this.#callbackUrl(),
    });
    if (principal === null) {
      throw new UnauthorizedException('The login did not succeed.');
    }

    // A new session ID at every login stops an attacker from planting one in advance.
    const previousSession = request.cookies[SESSION_COOKIE];
    if (previousSession !== undefined) {
      await this.#sessions.delete(hashSessionId(previousSession));
    }
    const sessionId = newSessionId();
    await this.#sessions.create(hashSessionId(sessionId), principal, {
      absoluteMs: this.#config.sessionAbsoluteMs,
      idleMs: this.#config.sessionIdleMs,
    });

    response.cookie(SESSION_COOKIE, sessionId, this.#cookieOptions(this.#config.sessionAbsoluteMs));
    response.redirect(302, this.#config.dashboardUrl);
  }

  @Authenticated()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: ApiRequest, @Res({ passthrough: true }) response: Response): Promise<void> {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId !== undefined) {
      await this.#sessions.delete(hashSessionId(sessionId));
    }
    response.clearCookie(SESSION_COOKIE, this.#cookieOptions());
  }

  @Authenticated()
  @Get('me')
  me(@Req() request: ApiRequest): object {
    const { subject, displayName, companyId, permissions } = request.principal!;
    return { subject, displayName, companyId, permissions };
  }

  #callbackUrl(): string {
    return `${this.#config.publicUrl}/api/v1/auth/callback`;
  }

  #cookieOptions(maxAge?: number): CookieOptions {
    return {
      httpOnly: true,
      // Lax rather than Strict, because the login provider's redirect is a cross-site navigation.
      sameSite: 'lax',
      secure: this.#config.secureCookies,
      path: '/',
      ...(maxAge !== undefined && { maxAge }),
    };
  }
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
