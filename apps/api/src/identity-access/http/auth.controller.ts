import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { CurrentUser, SignedOut } from '@dreamdevops/contracts/identity-access/http';
import type { CookieOptions, Response } from 'express';
import type { AppConfig } from '../../config/app-config.ts';
import { Authenticated, Public, SignInRateLimit } from '../../http/access.decorators.ts';
import { type ApiRequest, LOGIN_COOKIE, SESSION_COOKIE } from '../../http/request.ts';
import { APP_CONFIG } from '../../tokens.ts';
import { SignIn } from '../application/sign-in.ts';

const LOGIN_COOKIE_LIFETIME_MS = 10 * 60_000;

/**
 * The backend for frontend's login. The login provider's tokens stay on the server,
 * and the browser only holds an opaque session ID that scripts can't read. The login
 * itself is SignIn's; this keeps the cookies and redirects that carry it.
 */
@Controller('auth')
@SignInRateLimit()
export class AuthController {
  readonly #config: AppConfig;
  readonly #signIn: SignIn;

  constructor(@Inject(APP_CONFIG) config: AppConfig, @Inject(SignIn) signIn: SignIn) {
    this.#config = config;
    this.#signIn = signIn;
  }

  @Public()
  @Get('login')
  async login(@Query('login_hint') loginHint: unknown, @Query('mfa') mfa: unknown, @Res() response: Response): Promise<void> {
    const { authorizationUrl, attempt } = await this.#signIn.start(loginHint, mfa);
    response.cookie(LOGIN_COOKIE, attempt, this.#cookieOptions(LOGIN_COOKIE_LIFETIME_MS));
    response.redirect(302, authorizationUrl);
  }

  @Public()
  @Get('callback')
  async callback(@Query('state') state: unknown, @Req() request: ApiRequest, @Res() response: Response): Promise<void> {
    const attempt = request.cookies[LOGIN_COOKIE];
    response.clearCookie(LOGIN_COOKIE, this.#cookieOptions());
    const finished = await this.#signIn.finish({
      state,
      attempt,
      callbackPath: request.originalUrl,
      previousSessionId: request.cookies[SESSION_COOKIE],
    });
    if ('stepUp' in finished) {
      response.redirect(302, finished.stepUp);
      return;
    }
    response.cookie(SESSION_COOKIE, finished.sessionId, this.#cookieOptions(this.#config.sessionAbsoluteMs));
    response.redirect(302, this.#config.dashboardUrl);
  }

  /** Returns where the browser should go to end the login provider's session too. */
  @SkipThrottle({ auth: true })
  @Authenticated()
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() request: ApiRequest, @Res({ passthrough: true }) response: Response): Promise<SignedOut> {
    const signedOut = await this.#signIn.signOut(request.sessionIdHash!, request.session?.idToken ?? null);
    response.clearCookie(SESSION_COOKIE, this.#cookieOptions());
    return signedOut;
  }

  // The dashboard calls this often, so the strict login limit would lock people out.
  @SkipThrottle({ auth: true })
  @Authenticated()
  @Get('me')
  me(@Req() request: ApiRequest): CurrentUser {
    const { userId, email, displayName, companyId, companyName, role, permissions, memberships } = request.principal!;
    return { userId, email, displayName, companyId, companyName, role, permissions, memberships };
  }

  /** Chooses which of the user's companies this session acts for. */
  @SkipThrottle({ auth: true })
  @Authenticated()
  @Post('active-company')
  @HttpCode(204)
  chooseCompany(@Req() request: ApiRequest, @Body() body: { companyId?: unknown } | undefined): Promise<void> {
    return this.#signIn.chooseCompany(request.principal!, { idHash: request.sessionIdHash!, data: request.session! }, body?.companyId);
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
