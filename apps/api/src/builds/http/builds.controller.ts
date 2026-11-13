import { Body, Controller, Get, Header, Inject, Param, Post, Req } from '@nestjs/common';
import { Authenticated, RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { REPOSITORY_LOOKUP, type RepositoryLookup } from '../../source-governance/application/repository-lookup.ts';
import { Builds } from '../application/builds.ts';

/** Every member can see builds and versions. Users without a company are refused. */
@Controller('company')
export class BuildsController {
  readonly #builds: Builds;
  readonly #repositories: RepositoryLookup;

  constructor(@Inject(Builds) builds: Builds, @Inject(REPOSITORY_LOOKUP) repositories: RepositoryLookup) {
    this.#builds = builds;
    this.#repositories = repositories;
  }

  @Authenticated()
  @Get('applications/:id/builds')
  list(@Param('id') id: string): Promise<object[]> {
    return this.#builds.list(id);
  }

  /** The version list: signed images that passed every check. */
  @Authenticated()
  @Get('applications/:id/versions')
  versions(@Param('id') id: string): Promise<object[]> {
    return this.#builds.versions(id);
  }

  @Authenticated()
  @Get('applications/:id/branches')
  branches(@Param('id') id: string): Promise<string[]> {
    return this.#repositories.branches(id);
  }

  @RequirePermissions('feature-images:build')
  @Post('applications/:id/feature-builds')
  featureBuild(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: { branch?: unknown }): Promise<object> {
    return this.#builds.requestFeatureBuild(request.principal!, id, body?.branch);
  }

  @Authenticated()
  @Get('builds/:id')
  get(@Param('id') id: string): Promise<object> {
    return this.#builds.get(id);
  }

  @Authenticated()
  @Get('builds/:id/sbom')
  @Header('Content-Disposition', 'attachment; filename="sbom.cdx.json"')
  sbom(@Param('id') id: string): Promise<object> {
    return this.#builds.sbom(id);
  }

  /** The keys targets use to check images: test for feature and RC images, release for final ones. */
  @Authenticated()
  @Get('signing-keys')
  signingKeys(): Promise<object[]> {
    return this.#builds.publicKeys();
  }
}
