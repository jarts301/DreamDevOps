import { InMemoryJobQueue } from '../src/testing/index.ts';
import { describeJobQueueContract } from './job-queue-contract.ts';

describeJobQueueContract('in-memory fake', async () => {
  const queue = new InMemoryJobQueue();
  return {
    queue,
    eventually: async (assertion) => {
      await queue.drain();
      assertion();
    },
    deadLetters: async (queueName) => {
      await queue.drain();
      return queue.deadLettersOf(queueName);
    },
    stop: async () => {},
  };
});
