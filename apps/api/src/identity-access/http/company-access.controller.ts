import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { Authenticated, RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { CompanyAccessService } from '../application/company-access.service.ts';

const MANAGE_USERS = 'company-users:manage';

/** Members and invitations of the signed-in user's current company. */
@Controller('company')
export class CompanyAccessController {
  readonly #service: CompanyAccessService;

  constructor(@Inject(CompanyAccessService) service: CompanyAccessService) {
    this.#service = service;
  }

  @RequirePermissions(MANAGE_USERS)
  @Get('roles')
  roles(): Promise<object[]> {
    return this.#service.listRoles();
  }

  @RequirePermissions(MANAGE_USERS)
  @Get('members')
  members(): Promise<object[]> {
    return this.#service.listMembers();
  }

  @RequirePermissions(MANAGE_USERS)
  @Patch('members/:userId')
  @HttpCode(204)
  changeRole(@Req() request: ApiRequest, @Param('userId') userId: string, @Body() body: { role?: unknown }): Promise<void> {
    return this.#service.changeRole(request.principal!, userId, body?.role);
  }

  @RequirePermissions(MANAGE_USERS)
  @Delete('members/:userId')
  @HttpCode(204)
  removeMember(@Req() request: ApiRequest, @Param('userId') userId: string): Promise<void> {
    return this.#service.removeMember(request.principal!, userId);
  }

  @RequirePermissions(MANAGE_USERS)
  @Get('invitations')
  invitations(): Promise<object[]> {
    return this.#service.listInvitations();
  }

  @RequirePermissions(MANAGE_USERS)
  @Post('invitations')
  invite(@Req() request: ApiRequest, @Body() body: { email?: unknown; role?: unknown }): Promise<object> {
    return this.#service.invite(request.principal!, body?.email, body?.role);
  }

  @RequirePermissions(MANAGE_USERS)
  @Delete('invitations/:id')
  @HttpCode(204)
  revoke(@Req() request: ApiRequest, @Param('id') id: string): Promise<void> {
    return this.#service.revokeInvitation(request.principal!, id);
  }
}

@Controller('invitations')
export class InvitationsController {
  readonly #service: CompanyAccessService;

  constructor(@Inject(CompanyAccessService) service: CompanyAccessService) {
    this.#service = service;
  }

  @Authenticated()
  @Post('accept')
  @HttpCode(200)
  accept(@Req() request: ApiRequest, @Body() body: { token?: unknown }): Promise<object> {
    return this.#service.acceptInvitation(request.principal!, body?.token);
  }
}

@Controller('platform/companies')
export class PlatformCompaniesController {
  readonly #service: CompanyAccessService;

  constructor(@Inject(CompanyAccessService) service: CompanyAccessService) {
    this.#service = service;
  }

  @RequirePermissions('companies:manage')
  @Post(':companyId/first-admin-invitation')
  invite(
    @Req() request: ApiRequest,
    @Param('companyId') companyId: string,
    @Body() body: { email?: unknown },
  ): Promise<object> {
    return this.#service.inviteFirstAdmin(request.principal!, companyId, body?.email);
  }
}
