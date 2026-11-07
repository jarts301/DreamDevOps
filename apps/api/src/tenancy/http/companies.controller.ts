import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { InvitationEmails } from '../../notifications/application/invitation-emails.ts';
import { CompaniesService } from '../application/companies.service.ts';

const MANAGE_COMPANIES = 'companies:manage';

/** The platform's company register. Platform admins see names and states, never company data. */
@Controller('platform/companies')
@RequirePermissions(MANAGE_COMPANIES)
export class CompaniesController {
  readonly #service: CompaniesService;
  readonly #emails: InvitationEmails;

  constructor(
    @Inject(CompaniesService) service: CompaniesService,
    @Inject(InvitationEmails) emails: InvitationEmails,
  ) {
    this.#service = service;
    this.#emails = emails;
  }

  @Get()
  list(): Promise<object[]> {
    return this.#service.list();
  }

  @Post()
  async create(
    @Req() request: ApiRequest,
    @Body() body: { name?: unknown; firstAdminEmail?: unknown },
  ): Promise<object> {
    const { company, invitation } = await this.#service.create(request.principal!, body?.name, body?.firstAdminEmail);
    const emailSent = await this.#emails.send({
      to: invitation.email,
      companyName: company.name,
      role: invitation.role,
      invitedBy: request.principal!.displayName,
      invitation,
    });
    return { company, invitation: { ...invitation, emailSent } };
  }

  @Patch(':id')
  @HttpCode(204)
  rename(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: { name?: unknown }): Promise<void> {
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
  async inviteFirstAdmin(
    @Req() request: ApiRequest,
    @Param('id') id: string,
    @Body() body: { email?: unknown },
  ): Promise<object> {
    const { invitation, companyName } = await this.#service.inviteFirstAdmin(request.principal!, id, body?.email);
    const emailSent = await this.#emails.send({
      to: invitation.email,
      companyName,
      role: invitation.role,
      invitedBy: request.principal!.displayName,
      invitation,
    });
    return { ...invitation, emailSent };
  }
}
