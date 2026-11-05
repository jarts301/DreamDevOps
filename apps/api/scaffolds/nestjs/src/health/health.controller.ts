import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DATABASE, type Database } from '../database/database.module.js';

export interface Health {
  readonly status: 'ok' | 'unavailable';
  readonly database: 'up' | 'down' | 'not configured';
}

/** DreamDevOps calls this to know the API is running, and answers 503 if its database isn't reachable. */
@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  @Get()
  async check(@Res({ passthrough: true }) response: Response): Promise<Health> {
    if (this.database === null) {
      return { status: 'ok', database: 'not configured' };
    }
    try {
      await this.database.query('SELECT 1');
      return { status: 'ok', database: 'up' };
    } catch {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'unavailable', database: 'down' };
    }
  }
}
