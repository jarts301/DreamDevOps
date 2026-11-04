import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Pool } from 'pg';
import { DATABASE_POOL } from '../tokens.ts';
import { Public } from '../http/access.decorators.ts';

/** Answers only up or down, because anyone can call these routes. */
@Public()
@SkipThrottle({ default: true, auth: true })
@Controller('health')
export class HealthController {
  readonly #pool: Pool;

  constructor(@Inject(DATABASE_POOL) pool: Pool) {
    this.#pool = pool;
  }

  /** The process is running. */
  @Get('live')
  @HttpCode(200)
  live(): { status: string } {
    return { status: 'up' };
  }

  /** The process can serve requests, because it can reach its database. */
  @Get('ready')
  async ready(): Promise<{ status: string }> {
    try {
      await this.#pool.query('SELECT 1');
      return { status: 'up' };
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
