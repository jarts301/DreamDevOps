import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { type Application, ApplicationsService } from '../application/applications.service.ts';
import { type CompanyProfile, CompanyRegistryService } from '../application/company-registry.service.ts';

const VIEW_COMPANY = 'dashboards:view';
const VIEW = 'applications:view';
const CREATE = 'applications:create';
const UPDATE = 'applications:update';
const ARCHIVE = 'applications:archive';

/** The signed-in user's current company and its applications. */
@Controller('company')
export class CompanyController {
  readonly #registry: CompanyRegistryService;
  readonly #applications: ApplicationsService;

  constructor(
    @Inject(CompanyRegistryService) registry: CompanyRegistryService,
    @Inject(ApplicationsService) applications: ApplicationsService,
  ) {
    this.#registry = registry;
    this.#applications = applications;
  }

  @RequirePermissions(VIEW_COMPANY)
  @Get()
  profile(): Promise<CompanyProfile> {
    return this.#registry.current();
  }

  @RequirePermissions(VIEW)
  @Get('applications')
  applications(): Promise<Application[]> {
    return this.#applications.list();
  }

  @RequirePermissions(CREATE)
  @Post('applications')
  create(@Req() request: ApiRequest, @Body() body: unknown): Promise<Application> {
    return this.#applications.create(request.principal!, body);
  }

  @RequirePermissions(VIEW)
  @Get('applications/:applicationId')
  application(@Param('applicationId') applicationId: string): Promise<Application> {
    return this.#applications.get(applicationId);
  }

  @RequirePermissions(UPDATE)
  @Patch('applications/:applicationId')
  update(
    @Req() request: ApiRequest,
    @Param('applicationId') applicationId: string,
    @Body() body: unknown,
  ): Promise<Application> {
    return this.#applications.update(request.principal!, applicationId, body);
  }

  @RequirePermissions(ARCHIVE)
  @Post('applications/:applicationId/archive')
  @HttpCode(200)
  archive(@Req() request: ApiRequest, @Param('applicationId') applicationId: string): Promise<Application> {
    return this.#applications.changeStatus(request.principal!, applicationId, 'archive');
  }

  /** Makes the repository again, after it failed or for an application that predates repositories. */
  @RequirePermissions(CREATE)
  @Post('applications/:applicationId/repository')
  @HttpCode(202)
  repository(@Req() request: ApiRequest, @Param('applicationId') applicationId: string): Promise<Application> {
    return this.#applications.requestRepository(request.principal!, applicationId);
  }

  @RequirePermissions(ARCHIVE)
  @Post('applications/:applicationId/restore')
  @HttpCode(200)
  restore(@Req() request: ApiRequest, @Param('applicationId') applicationId: string): Promise<Application> {
    return this.#applications.changeStatus(request.principal!, applicationId, 'restore');
  }
}
