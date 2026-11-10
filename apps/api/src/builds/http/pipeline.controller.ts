import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { Builds, type ReportKind } from '../application/builds.ts';
import { BuildError } from '../domain/errors.ts';

const REPORTS: readonly ReportKind[] = ['secrets', 'tests', 'scan', 'sbom', 'failure'];

const bearer = (request: ApiRequest): string | undefined => {
  const match = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(request.headers.authorization ?? '');
  return match?.[1];
};

/**
 * Called by pipeline jobs, which have no session. Each call carries the build's
 * one-time token, which only works for that build while it runs.
 */
@Controller('pipeline/builds')
@Public()
@SkipThrottle()
export class PipelineController {
  readonly #builds: Builds;

  constructor(@Inject(Builds) builds: Builds) {
    this.#builds = builds;
  }

  @Get(':id/source')
  async source(@Req() request: ApiRequest, @Res() response: Response, @Param('id') id: string): Promise<void> {
    const archive = await this.#builds.source(id, bearer(request));
    response.status(200).type('application/gzip');
    await pipeline(Readable.fromWeb(archive as import('node:stream/web').ReadableStream), response);
  }

  @Post(':id/reports/:kind')
  @HttpCode(204)
  async report(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Query('passed') passed: unknown,
  ): Promise<void> {
    if (!REPORTS.includes(kind as ReportKind)) {
      throw new BuildError('not-found', 'There is no such report.');
    }
    await this.#builds.report(id, bearer(request), kind as ReportKind, request, passed);
  }

  @Post(':id/jobs/:job/started')
  @HttpCode(204)
  async jobStarted(@Req() request: ApiRequest, @Param('id') id: string, @Param('job') job: string): Promise<void> {
    await this.#builds.jobStarted(id, bearer(request), job);
  }

  @Post(':id/image/parts/:part')
  @HttpCode(204)
  async receiveImagePart(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Param('part') part: string,
  ): Promise<void> {
    await this.#builds.receiveImagePart(id, bearer(request), part, request);
  }

  @Post(':id/image/complete')
  @HttpCode(204)
  async completeImage(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Query('parts') parts: unknown,
    @Query('sha256') hash: unknown,
  ): Promise<void> {
    await this.#builds.completeImage(id, bearer(request), parts, hash);
  }

  @Get(':id/image')
  async image(@Req() request: ApiRequest, @Res() response: Response, @Param('id') id: string): Promise<void> {
    const image = await this.#builds.image(id, bearer(request));
    response.status(200).type('application/x-tar');
    await pipeline(image, response);
  }
}
