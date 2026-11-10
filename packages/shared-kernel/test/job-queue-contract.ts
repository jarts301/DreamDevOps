import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Job, JobQueue } from '../src/index.ts';

export interface JobQueueHarness {
  readonly queue: JobQueue;
  /** Waits until the assertion passes, allowing for the implementation's own timing. */
  eventually(assertion: () => void): Promise<void>;
  deadLetters(queueName: string): Promise<readonly Job[]>;
  stop(): Promise<void>;
}

/** Every JobQueue implementation must pass these, so the fake can't drift from pg-boss. */
export function describeJobQueueContract(name: string, createHarness: () => Promise<JobQueueHarness>): void {
  describe(`JobQueue contract: ${name}`, () => {
    let harness: JobQueueHarness;
    const queueName = () => `contract.${randomUUID()}`;

    beforeAll(async () => {
      harness = await createHarness();
    });

    afterAll(async () => {
      await harness.stop();
    });

    it('delivers a job to its worker', async () => {
      const queue = queueName();
      const handler = vi.fn(async (_job: Job) => {});
      await harness.queue.createQueue(queue);
      await harness.queue.work(queue, handler);

      await harness.queue.send(queue, { value: 1 });

      await harness.eventually(() => {
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]?.[0].data).toEqual({ value: 1 });
      });
    });

    it('does not accept the same job ID twice', async () => {
      const queue = queueName();
      const id = randomUUID();
      await harness.queue.createQueue(queue);

      await expect(harness.queue.send(queue, {}, { id })).resolves.toBe(id);
      await expect(harness.queue.send(queue, {}, { id })).resolves.toBeNull();
    });

    it('refuses a job ID that is not a UUID', async () => {
      const queue = queueName();
      await harness.queue.createQueue(queue);

      await expect(harness.queue.send(queue, {}, { id: 'not-a-uuid' })).rejects.toThrow();
    });

    it('runs a failed job again', async () => {
      const queue = queueName();
      let calls = 0;
      await harness.queue.createQueue(queue, { retryLimit: 2, retryDelaySeconds: 1 });
      await harness.queue.work(queue, async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('Temporary failure');
        }
      });

      await harness.queue.send(queue, {});

      await harness.eventually(() => expect(calls).toBe(2));
    });

    it('works through a backlog quickly, not one job per polling interval', async () => {
      const queue = queueName();
      let done = 0;
      await harness.queue.createQueue(queue);
      await harness.queue.work(queue, async () => {
        done += 1;
      });
      const started = Date.now();

      for (let index = 0; index < 40; index += 1) {
        await harness.queue.send(queue, { index });
      }

      await harness.eventually(() => expect(done).toBe(40));
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it('retries only the job that failed, not the jobs beside it', async () => {
      const queue = queueName();
      const calls = new Map<number, number>();
      await harness.queue.createQueue(queue, { retryLimit: 2, retryDelaySeconds: 1 });
      await harness.queue.work(queue, async (job) => {
        const index = (job.data as { index: number }).index;
        calls.set(index, (calls.get(index) ?? 0) + 1);
        if (index === 2 && calls.get(index) === 1) {
          throw new Error('Temporary failure');
        }
      });

      for (let index = 0; index < 5; index += 1) {
        await harness.queue.send(queue, { index });
      }

      await harness.eventually(() => expect(calls.get(2)).toBe(2));
      expect([0, 1, 3, 4].map((index) => calls.get(index))).toEqual([1, 1, 1, 1]);
    });

    it('moves a job to the dead letter queue when its retries run out', async () => {
      const queue = queueName();
      await harness.queue.createQueue(queue, { retryLimit: 1, retryDelaySeconds: 1 });
      await harness.queue.work(queue, async () => {
        throw new Error('Permanent failure');
      });

      await harness.queue.send(queue, { value: 2 });

      await vi.waitFor(
        async () => {
          const deadLetters = await harness.deadLetters(queue);
          expect(deadLetters.map((job) => job.data)).toEqual([{ value: 2 }]);
        },
        { timeout: 20_000, interval: 250 },
      );
    });

    it('applies changed settings when a queue is created again, such as after a restart', async () => {
      const queue = queueName();
      let calls = 0;
      await harness.queue.createQueue(queue, { retryLimit: 1, retryDelaySeconds: 600 });
      await harness.queue.createQueue(queue, { retryLimit: 1, retryDelaySeconds: 1 });
      await harness.queue.work(queue, async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('Temporary failure');
        }
      });

      await harness.queue.send(queue, {});

      await harness.eventually(() => expect(calls).toBe(2));
    });

    it('runs long jobs one at a time per worker, with a heartbeat and a longer expiry', async () => {
      const queue = queueName();
      const handled: number[] = [];
      await harness.queue.createQueue(queue, { retryLimit: 1, expireInSeconds: 7_200, heartbeatSeconds: 30 });
      await harness.queue.work(
        queue,
        async (job) => {
          handled.push((job.data as { value: number }).value);
        },
        { concurrency: 2 },
      );

      for (const value of [1, 2, 3]) {
        await harness.queue.send(queue, { value });
      }

      await harness.eventually(() => expect([...handled].sort()).toEqual([1, 2, 3]));
    });
  });
}
