import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { CookieOptions, Response } from 'express';
import type { AppConfig } from '../../config/app-config.ts';
import { Authenticated, Public } from '../../http/access.decorators.ts';
import { type ApiRequest, LOGIN_COOKIE, SESSION_COOKIE } from '../../http/request.ts';
import { hashSessionId, newSessionId, SESSION_STORE, type SessionStore } from '../../session/session-store.ts';
import { APP_CONFIG } from '../../tokens.ts';
import { IDENTITY_PROVIDER, type IdentityProvider, USER_DIRECTORY, type UserDirectory } from '../application/ports.ts';

const LOGIN_COOKIE_LIFETIME_MS = 10 * 60_000;

/**
 * The backend for frontend's login. The login provider's tokens stay on the server,
 * and the browser only holds an opaque session ID that scripts can't read.
 */
@Controller('auth')
export class AuthController {
  readonly #config: AppConfig;
  readonly #identityProvider: IdentityProvider;
  readonly #directory: UserDirectory;
  readonly #sessions: SessionStore;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(IDENTITY_PROVIDER) identityProvider: IdentityProvider,
    @Inject(USER_DIRECTORY) directory: UserDirectory,
    @Inject(SESSION_STORE) sessions: SessionStore,
  ) {
    this.#config = config;
    this.#identityProvider = identityProvider;
    this.#directory = directory;
    this.#sessions = sessions;
  }

  @Public()
  @Get('login')
  async login(@Query('login_hint') loginHint: unknown, @Res() response: Response): Promise<void> {
    const state = randomValue();
    const nonce = randomValue();
    const codeVerifier = randomValue();

    const authorizationUrl = await this.#identityProvider.authorizationUrl({
      state,
      nonce,
      codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      redirectUri: this.#callbackUrl(),
      ...(typeof loginHint === 'string' && { loginHint }),
    });

    response.cookie(LOGIN_COOKIE, `${state}.${nonce}.${codeVerifier}`, this.#cookieOptions(LOGIN_COOKIE_LIFETIME_MS));
    response.redirect(302, authorizationUrl);
  }

  @Public()
  @Get('callback')
  async callback(
    @Query('state') state: unknown,
    @Req() request: ApiRequest,
    @Res() response: Response,
  ): Promise<void> {
    const [expectedState, nonce, codeVerifier] = (request.cookies[LOGIN_COOKIE] ?? '').split('.');
    response.clearCookie(LOGIN_COOKIE, this.#cookieOptions());

    if (typeof state !== 'string' || !expectedState || !nonce || !codeVerifier || !sameText(state, expectedState)) {
      throw new BadRequestException('This login attempt is not valid. Start again.');
    }

    const identity = await this.#identityProvider.exchangeCode({
      callbackUrl: new URL(`${this.#config.publicUrl}${request.originalUrl}`),
      state: expectedState,
      nonce,
      codeVerifier,
    });
    if (identity === null) {
      throw new UnauthorizedException('The login did not succeed.');
    }
    const userId = await this.#directory.recordLogin(identity);

    // A new session ID at every login stops an attacker from planting one in advance.
    const previousSession = request.cookies[SESSION_COOKIE];
    if (previousSession !== undefined) {
      await this.#sessions.delete(hashSessionId(previousSession));
    }
    const sessionId = newSessionId();
    await this.#sessions.create(
      hashSessionId(sessionId),
      { userId, chosenCompanyId: null, idToken: identity.idToken },
      { absoluteMs: this.#config.sessionAbsoluteMs, idleMs: this.#config.sessionIdleMs },
    );

    response.cookie(SESSION_COOKIE, sessionId, this.#cookieOptions(this.#config.sessionAbsoluteMs));
    response.redirect(302, this.#config.dashboardUrl);
  }

  /** Returns where the browser should go to end the login provider's session too. */
  @SkipThrottle({ auth: true })
  @Authenticated()
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() request: ApiRequest, @Res({ passthrough: true }) response: Response): Promise<object> {
    await this.#sessions.delete(request.sessionIdHash!);
    response.clearCookie(SESSION_COOKIE, this.#cookieOptions());
    return {
      logoutUrl: await this.#identityProvider.logoutUrl({
        idToken: request.session?.idToken ?? null,
        postLogoutRedirectUri: this.#config.dashboardUrl,
      }),
    };
  }

  // The dashboard calls this often, so the strict login limit would lock people out.
  @SkipThrottle({ auth: true })
  @Authenticated()
  @Get('me')
  me(@Req() request: ApiRequest): object {
    const { userId, email, displayName, companyId, companyName, role, permissions, memberships } = request.principal!;
    return { userId, email, displayName, companyId, companyName, role, permissions, memberships };
  }

  /** Chooses which of the user's companies this session acts for. */
  @SkipThrottle({ auth: true })
  @Authenticated()
  @Post('active-company')
  @HttpCode(204)
  async chooseCompany(@Req() request: ApiRequest, @Body() body: { companyId?: unknown }): Promise<void> {
    const companyId = body?.companyId;
    if (!request.principal!.memberships.some((membership) => membership.companyId === companyId)) {
      throw new ForbiddenException('You are not a member of this company.');
    }
    await this.#sessions.update(request.sessionIdHash!, { ...request.session!, chosenCompanyId: companyId as string });
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

function randomValue(): string {
  return randomBytes(32).toString('base64url');
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
