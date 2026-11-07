import { Body, Controller, Get, HttpCode, Inject, Param, Put, Req } from '@nestjs/common';
import { Authenticated, RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { Entitlements } from '../application/entitlements.ts';

@Controller()
export class EditionsController {
  readonly #entitlements: Entitlements;

  constructor(@Inject(Entitlements) entitlements: Entitlements) {
    this.#entitlements = entitlements;
  }

  /** Every member may see what their company's edition includes. Users without a company are refused. */
  @Authenticated()
  @Get('company/entitlements')
  company(): Promise<object> {
    return this.#entitlements.forCurrentCompany();
  }

  @RequirePermissions('editions:manage')
  @Get('platform/editions')
  list(): Promise<object> {
    return this.#entitlements.listCompanies();
  }

  @RequirePermissions('editions:manage')
  @Put('platform/editions/:companyId')
  @HttpCode(204)
  set(
    @Req() request: ApiRequest,
    @Param('companyId') companyId: string,
    @Body() body: { edition?: unknown },
  ): Promise<void> {
    return this.#entitlements.setEdition(request.principal!, companyId, body?.edition);
  }
}
