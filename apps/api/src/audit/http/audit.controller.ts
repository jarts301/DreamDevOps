import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { ActivityEntry, AuditEntry, HistoryPage, IntegrityCheck } from '@dreamdevops/contracts/audit/http';
import { RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { AuditLog } from '../application/audit-log.ts';

@Controller()
export class AuditController {
  readonly #log: AuditLog;

  constructor(@Inject(AuditLog) log: AuditLog) {
    this.#log = log;
  }

  @RequirePermissions('audit:read')
  @Get('company/audit')
  list(@Query('before') before: unknown): Promise<HistoryPage<AuditEntry>> {
    return this.#log.listCompany(before);
  }

  @RequirePermissions('audit:read')
  @Get('company/audit/verify')
  verify(): Promise<IntegrityCheck> {
    return this.#log.verify();
  }

  /** A platform admin's own actions, across every company they acted on. */
  @RequirePermissions('audit:read-own')
  @Get('platform/audit')
  mine(@Req() request: ApiRequest, @Query('before') before: unknown): Promise<HistoryPage<ActivityEntry>> {
    return this.#log.listByActor(request.principal!.userId, before);
  }
}
