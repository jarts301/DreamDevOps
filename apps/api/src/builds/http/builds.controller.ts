import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { Authenticated, RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { BuildQueries } from '../application/build-queries.ts';
import { BUILD_FEATURE_IMAGES, Builds, START_RELEASES } from '../application/builds.ts';
import { IMAGE_SIGNING_KEY } from '../application/tokens.ts';
import { SIGNING_ALGORITHM, type SigningKey } from '../domain/signature.ts';

/**
 * Every member can follow builds. Developers and Tech Leads build development images,
 * and Tech Leads start releases and hotfixes. Users without a company are refused.
 */
@Controller('company')
export class BuildsController {
  readonly #builds: Builds;
  readonly #queries: BuildQueries;
  readonly #key: SigningKey;

  constructor(
    @Inject(Builds) builds: Builds,
    @Inject(BuildQueries) queries: BuildQueries,
    @Inject(IMAGE_SIGNING_KEY) key: SigningKey,
  ) {
    this.#builds = builds;
    this.#queries = queries;
    this.#key = key;
  }

  @Authenticated()
  @Get('applications/:id/builds')
  list(@Param('id') id: string): Promise<object[]> {
    return this.#queries.list(id);
  }

  @Authenticated()
  @Get('applications/:id/versions')
  versions(@Param('id') id: string): Promise<object> {
    return this.#queries.versions(id);
  }

  @Authenticated()
  @Get('applications/:id/pull-requests')
  pullRequests(@Param('id') id: string): Promise<object[]> {
    return this.#queries.pullRequests(id);
  }

  /** Looks for merges into main the platform missed, such as while it was stopped. Safe to repeat. */
  @Authenticated()
  @Post('applications/:id/builds/sync')
  async sync(@Param('id') id: string): Promise<object> {
    return { found: await this.#builds.reconcile(id) };
  }

  @RequirePermissions(BUILD_FEATURE_IMAGES)
  @Post('applications/:id/pull-requests/:number/builds')
  @HttpCode(202)
  buildDevelopmentImage(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Param('number') number: string,
  ): Promise<object> {
    return this.#builds.requestDevelopmentBuild(request.principal!, id, number);
  }

  @RequirePermissions(START_RELEASES)
  @Post('applications/:id/releases')
  @HttpCode(202)
  startRelease(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: { bump?: unknown }): Promise<object> {
    return this.#builds.startRelease(request.principal!, id, body?.bump);
  }

  @RequirePermissions(START_RELEASES)
  @Post('applications/:id/hotfixes')
  @HttpCode(202)
  startHotfix(@Req() request: ApiRequest, @Param('id') id: string): Promise<object> {
    return this.#builds.startHotfix(request.principal!, id);
  }

  @RequirePermissions(START_RELEASES)
  @Post('applications/:id/candidates')
  @HttpCode(202)
  buildCandidate(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: { branch?: unknown }): Promise<object> {
    return this.#builds.requestCandidate(request.principal!, id, body?.branch);
  }

  @Authenticated()
  @Get('builds/:buildId')
  get(@Param('buildId') buildId: string): Promise<object> {
    return this.#queries.get(buildId);
  }

  /** Who may try again depends on the kind of build, so the service checks the permission. */
  @Authenticated()
  @Post('builds/:buildId/retry')
  @HttpCode(202)
  retry(@Req() request: ApiRequest, @Param('buildId') buildId: string): Promise<object> {
    return this.#builds.retry(request.principal!, buildId);
  }

  /** The public key that checks every image's signature. It's public, so any member may read it. */
  @Authenticated()
  @Get('image-signing-key')
  signingKey(): object {
    return { algorithm: SIGNING_ALGORITHM, fingerprint: this.#key.fingerprint, publicKey: this.#key.publicKeyPem };
  }
}
