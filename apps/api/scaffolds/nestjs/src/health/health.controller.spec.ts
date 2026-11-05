import type { Response } from 'express';
import type pg from 'pg';
import { HealthController } from './health.controller.js';

const response = () =>
  ({ status: vi.fn() }) as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
  };

describe('HealthController', () => {
  it('is healthy without a database', async () => {
    await expect(new HealthController(null).check(response())).resolves.toEqual(
      {
        status: 'ok',
        database: 'not configured',
      },
    );
  });

  it('checks the database when there is one', async () => {
    const database = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as pg.Pool;

    await expect(
      new HealthController(database).check(response()),
    ).resolves.toEqual({ status: 'ok', database: 'up' });
  });

  it('answers 503 when the database is down', async () => {
    const database = {
      query: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as pg.Pool;
    const res = response();

    await expect(new HealthController(database).check(res)).resolves.toEqual({
      status: 'unavailable',
      database: 'down',
    });
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
