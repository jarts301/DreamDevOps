import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type pg from 'pg';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
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
      controllers: [AuditController],
      providers: withOverrides(
        [
          {
            provide: AuditLog,
            useFactory: (database: TenantDatabase, pool: pg.Pool) => new AuditLog(database, pool),
            inject: [TenantDatabase, DATABASE_POOL],
          },
          { provide: AuditSubscriptions, useFactory: (audit: AuditLog) => new AuditSubscriptions(audit), inject: [AuditLog] },
        ],
        settings.overrides,
      ),
      exports: [AuditSubscriptions],
    }));
  }
}
