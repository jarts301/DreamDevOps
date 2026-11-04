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
  });
}
