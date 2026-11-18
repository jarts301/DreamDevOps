import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withRenewal } from '../src/index.ts';

describe('withRenewal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renews the claim while the work runs, and stops when it ends', async () => {
    const renew = vi.fn(async () => {});
    let finish = () => {};
    const running = withRenewal(renew, { everyMs: 1_000 }, () => new Promise<string>((resolve) => (finish = () => resolve('done'))));

    await vi.advanceTimersByTimeAsync(3_500);
    expect(renew).toHaveBeenCalledTimes(3);

    finish();
    await expect(running).resolves.toBe('done');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(renew).toHaveBeenCalledTimes(3);
  });

  it('stops renewing when the work fails too', async () => {
    const renew = vi.fn(async () => {});
    const running = withRenewal(renew, { everyMs: 1_000 }, async () => {
      throw new Error('Git is down');
    });

    await expect(running).rejects.toThrow('Git is down');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(renew).not.toHaveBeenCalled();
  });

  it('reports a failed renewal and carries on with the work', async () => {
    const errors: unknown[] = [];
    let finish = () => {};
    const running = withRenewal(
      async () => {
        throw new Error('Database busy');
      },
      { everyMs: 1_000, onError: (error) => errors.push(error) },
      () => new Promise<void>((resolve) => (finish = resolve)),
    );

    await vi.advanceTimersByTimeAsync(1_500);
    finish();
    await running;

    expect(errors).toHaveLength(1);
  });
});
