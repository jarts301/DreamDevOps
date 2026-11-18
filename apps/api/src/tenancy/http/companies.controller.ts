import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { Unchecked } from '@dreamdevops/contracts/http';
import type { SentInvitation } from '@dreamdevops/contracts/identity-access/http';
import type {
  CompanySummary,
  CreateCompany,
  CreatedCompany,
  InviteFirstAdmin,
  RenameCompany,
} from '@dreamdevops/contracts/tenancy/http';
import { RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { CompaniesService } from '../application/companies.service.ts';

const MANAGE_COMPANIES = 'companies:manage';

/** The platform's company register. Platform admins see names and states, never company data. */
@Controller('platform/companies')
@RequirePermissions(MANAGE_COMPANIES)
export class CompaniesController {
  readonly #service: CompaniesService;

  constructor(@Inject(CompaniesService) service: CompaniesService) {
    this.#service = service;
  }

  @Get()
  list(): Promise<CompanySummary[]> {
    return this.#service.list();
  }

  @Post()
  create(@Req() request: ApiRequest, @Body() body: Unchecked<CreateCompany> | undefined): Promise<CreatedCompany> {
    return this.#service.create(request.principal!, body?.name, body?.firstAdminEmail);
  }

  @Patch(':id')
  @HttpCode(204)
  rename(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Unchecked<RenameCompany> | undefined): Promise<void> {
    return this.#service.rename(request.principal!, id, body?.name);
  }

  @Post(':id/suspend')
  @HttpCode(204)
  suspend(@Req() request: ApiRequest, @Param('id') id: string): Promise<void> {
    return this.#service.suspend(request.principal!, id);
  }

  @Post(':id/reactivate')
  @HttpCode(204)
  reactivate(@Req() request: ApiRequest, @Param('id') id: string): Promise<void> {
    return this.#service.reactivate(request.principal!, id);
  }

  @Post(':id/provision')
  @HttpCode(204)
  retryProvisioning(@Req() request: ApiRequest, @Param('id') id: string): Promise<void> {
    return this.#service.retryProvisioning(request.principal!, id);
  }

  @Post(':id/first-admin-invitation')
  inviteFirstAdmin(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Body() body: Unchecked<InviteFirstAdmin> | undefined,
  ): Promise<SentInvitation> {
    return this.#service.inviteFirstAdmin(request.principal!, id, body?.email);
  }
}
