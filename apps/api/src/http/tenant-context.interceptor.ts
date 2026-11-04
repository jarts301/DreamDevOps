import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { Observable } from 'rxjs';
import type { ApiRequest } from './request.ts';

/**
 * Runs each request in the company of the signed-in user. The company comes only from
 * the server-side session, so nothing a client sends can change it.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const companyId = context.switchToHttp().getRequest<ApiRequest>().principal?.companyId;
    if (companyId === undefined || companyId === null) {
      return next.handle();
    }
    const company = parseCompanyId(companyId);
    // The handler runs when subscribed to, so the subscription must be inside the context.
    return new Observable((subscriber) =>
      runWithCompany(company, () => next.handle().subscribe(subscriber)),
    );
  }
}
