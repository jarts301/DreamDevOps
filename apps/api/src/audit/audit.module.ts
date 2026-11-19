import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { COMPANY_DIRECTORY, type CompanyDirectory } from '@dreamdevops/contracts/tenancy/services';
import { CompanyDirectoryModule } from '../tenancy/company-directory.module.ts';
import { AuditLog } from './application/audit-log.ts';
import { AUDIT_STORE, type AuditStore } from './application/ports.ts';
import { AuditController } from './http/audit.controller.ts';
import { postgresAuditStore } from './infrastructure/postgres-audit-store.ts';
import { AuditSubscriptions } from './messaging/audit-subscriptions.ts';

/** Each company's tamper-evident history of changes. */
@Module({})
export class AuditModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, AuditModule, () => ({
      module: AuditModule,
      imports: [CompanyDirectoryModule.register(settings)],
      controllers: [AuditController],
      providers: withOverrides(
        [
          { provide: AUDIT_STORE, useFactory: postgresAuditStore, inject: [TenantDatabase] },
          {
            provide: AuditLog,
            useFactory: (store: AuditStore, companies: CompanyDirectory) => new AuditLog(store, companies),
            inject: [AUDIT_STORE, COMPANY_DIRECTORY],
          },
          { provide: AuditSubscriptions, useFactory: (audit: AuditLog) => new AuditSubscriptions(audit), inject: [AuditLog] },
        ],
        settings.overrides,
      ),
      exports: [AuditSubscriptions],
    }));
  }
}
