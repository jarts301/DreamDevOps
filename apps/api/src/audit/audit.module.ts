import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type pg from 'pg';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { COMPANY_DIRECTORY, type CompanyDirectory } from '../tenancy/application/company-directory.ts';
import { CompanyDirectoryModule } from '../tenancy/company-directory.module.ts';
import { DATABASE_POOL } from '../tokens.ts';
import { AuditLog } from './application/audit-log.ts';
import { AuditController } from './http/audit.controller.ts';
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
          {
            provide: AuditLog,
            useFactory: (database: TenantDatabase, pool: pg.Pool, companies: CompanyDirectory) => new AuditLog(database, pool, companies),
            inject: [TenantDatabase, DATABASE_POOL, COMPANY_DIRECTORY],
          },
          { provide: AuditSubscriptions, useFactory: (audit: AuditLog) => new AuditSubscriptions(audit), inject: [AuditLog] },
        ],
        settings.overrides,
      ),
      exports: [AuditSubscriptions],
    }));
  }
}
