import { describe, expect, it, vi } from 'vitest';
import type { FailedAttempt } from '../src/index.ts';
import { InMemoryJobQueue } from '../src/testing/index.ts';
import { describeJobQueueContract } from './job-queue-contract.ts';

describeJobQueueContract('in-memory fake', async () => {
  const failures: FailedAttempt[] = [];
  const queue = new InMemoryJobQueue({ onJobFailed: (failure) => failures.push(failure) });
  return {
    queue,
    failures,
    // Polls rather than drains, so a test can hold a job open while it checks something.
    eventually: (assertion) => vi.waitFor(assertion, { timeout: 2_000, interval: 5 }),
    deadLetters: async (queueName) => {
      await queue.drain();
      return queue.deadLettersOf(queueName);
    },
    stop: async () => {},
  };
});

describe('the in-memory fake’s schedules', () => {
  it('run only when a test says their time came, with the latest schedule of each queue', async () => {
    const queue = new InMemoryJobQueue();
    const seen: object[] = [];
    await queue.createQueue('ticks');
    await queue.work('ticks', async (job) => {
      seen.push(job.data);
    });

    await queue.schedule('ticks', '* * * * *', { round: 1 });
    await queue.schedule('ticks', '*/5 * * * *', { round: 2 });
    await queue.drain();
    expect(seen).toEqual([]);

    await queue.runSchedules();
    expect(seen).toEqual([{ round: 2 }]);
    expect(queue.schedulesOf().get('ticks')).toEqual({ cron: '*/5 * * * *', data: { round: 2 } });
  });

  it('wait, when drained, for jobs that jobs send too', async () => {
    const queue = new InMemoryJobQueue();
    const seen: string[] = [];
    await queue.createQueue('first');
    await queue.createQueue('second');
    await queue.work('second', async () => {
      seen.push('second');
    });
    await queue.work('first', async () => {
      seen.push('first');
      await queue.send('second', {});
    });

    await queue.send('first', {});
    await queue.drain();

    expect(seen).toEqual(['first', 'second']);
  });

  it('refuse what isn’t a cron expression', async () => {
    const queue = new InMemoryJobQueue();
    await queue.createQueue('ticks');

    await expect(queue.schedule('ticks', 'every minute')).rejects.toThrow('cron expression');
  });
});
