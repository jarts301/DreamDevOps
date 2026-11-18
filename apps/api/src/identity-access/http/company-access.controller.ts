import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { Authenticated, RequirePermissions, SignInRateLimit } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import type {
  AcceptedInvitation,
  InvitationView,
  MemberView,
  RoleView,
  SentInvitation,
} from '@dreamdevops/contracts/identity-access/http';
import { INVITATION_MAILER, type InvitationMailer } from '@dreamdevops/contracts/notifications/services';
import { CompanyAccessService } from '../application/company-access.service.ts';

const MANAGE_USERS = 'company-users:manage';

/** Members and invitations of the signed-in user's current company. */
@Controller('company')
export class CompanyAccessController {
  readonly #service: CompanyAccessService;
  readonly #emails: InvitationMailer;

  constructor(
    @Inject(CompanyAccessService) service: CompanyAccessService,
    @Inject(INVITATION_MAILER) emails: InvitationMailer,
  ) {
    this.#service = service;
    this.#emails = emails;
  }

  @RequirePermissions(MANAGE_USERS)
  @Get('roles')
  roles(): Promise<RoleView[]> {
    return this.#service.listRoles();
  }

  @RequirePermissions(MANAGE_USERS)
  @Get('members')
  members(): Promise<MemberView[]> {
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
  invitations(): Promise<InvitationView[]> {
    return this.#service.listInvitations();
  }

  @RequirePermissions(MANAGE_USERS)
  @Post('invitations')
  async invite(@Req() request: ApiRequest, @Body() body: { email?: unknown; role?: unknown }): Promise<SentInvitation> {
    const principal = request.principal!;
    const invitation = await this.#service.invite(principal, body?.email, body?.role);
    const emailSent = await this.#emails.send({
      to: invitation.email,
      companyName: principal.companyName ?? 'your company',
      role: invitation.role,
      invitedBy: principal.displayName,
      token: invitation.token,
      expiresAt: invitation.expiresAt,
    });
    return { ...invitation, emailSent };
  }

  @RequirePermissions(MANAGE_USERS)
  @Delete('invitations/:id')
  @HttpCode(204)
  revoke(@Req() request: ApiRequest, @Param('id') id: string): Promise<void> {
    return this.#service.revokeInvitation(request.principal!, id);
  }
}

@Controller('invitations')
@SignInRateLimit()
export class InvitationsController {
  readonly #service: CompanyAccessService;

  constructor(@Inject(CompanyAccessService) service: CompanyAccessService) {
    this.#service = service;
  }

  @Authenticated()
  @Post('accept')
  @HttpCode(200)
  accept(@Req() request: ApiRequest, @Body() body: { token?: unknown }): Promise<AcceptedInvitation> {
    return this.#service.acceptInvitation(request.principal!, body?.token);
  }
}
