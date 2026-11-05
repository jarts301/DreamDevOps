import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { CompanyRegistryService, type PlatformCompany } from '../application/company-registry.service.ts';

const MANAGE_COMPANIES = 'companies:manage';

/** The company registry and lifecycle, for Platform Admins. None of it reveals company data. */
@RequirePermissions(MANAGE_COMPANIES)
@Controller('platform/companies')
export class PlatformCompanyRegistryController {
  readonly #service: CompanyRegistryService;

  constructor(@Inject(CompanyRegistryService) service: CompanyRegistryService) {
    this.#service = service;
  }

  @Get()
  list(): Promise<PlatformCompany[]> {
    return this.#service.list();
  }

  @Post()
  create(@Req() request: ApiRequest, @Body() body: { name?: unknown; slug?: unknown }): Promise<PlatformCompany> {
    return this.#service.create(request.principal!, body?.name, body?.slug);
  }

  @Get(':companyId')
  get(@Param('companyId') companyId: string): Promise<PlatformCompany> {
    return this.#service.get(companyId);
  }

  @Patch(':companyId')
  rename(
    @Req() request: ApiRequest,
    @Param('companyId') companyId: string,
    @Body() body: { name?: unknown },
  ): Promise<PlatformCompany> {
    return this.#service.rename(request.principal!, companyId, body?.name);
  }

  @Post(':companyId/suspend')
  @HttpCode(200)
  suspend(@Req() request: ApiRequest, @Param('companyId') companyId: string): Promise<PlatformCompany> {
    return this.#service.changeStatus(request.principal!, companyId, 'suspend');
  }

  @Post(':companyId/reactivate')
  @HttpCode(200)
  reactivate(@Req() request: ApiRequest, @Param('companyId') companyId: string): Promise<PlatformCompany> {
    return this.#service.changeStatus(request.principal!, companyId, 'reactivate');
  }

  @Post(':companyId/close')
  @HttpCode(200)
  close(@Req() request: ApiRequest, @Param('companyId') companyId: string): Promise<PlatformCompany> {
    return this.#service.changeStatus(request.principal!, companyId, 'close');
  }

  /** Permanent. The company must be closed, and `confirmation` must be its slug. */
  @Post(':companyId/erase')
  @HttpCode(200)
  erase(
    @Req() request: ApiRequest,
    @Param('companyId') companyId: string,
    @Body() body: { confirmation?: unknown },
  ): Promise<PlatformCompany> {
    return this.#service.erase(request.principal!, companyId, body?.confirmation);
  }

  @Post(':companyId/provisioning')
  @HttpCode(202)
  provision(@Req() request: ApiRequest, @Param('companyId') companyId: string): Promise<PlatformCompany> {
    return this.#service.requestProvisioning(request.principal!, companyId);
  }
}
