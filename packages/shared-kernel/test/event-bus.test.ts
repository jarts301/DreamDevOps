import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDomainEvent, currentCompanyId, EventBus, parseCompanyId, UnrecoverableJobError } from '../src/index.ts';
import { InMemoryJobQueue } from '../src/testing/index.ts';
import { contractFor } from './contracts.ts';

const companyId = parseCompanyId('a1b2c3d4-0000-4000-8000-00000000000a');
const event = createDomainEvent({ eventType: 'ApplicationCreated', companyId, payload: { name: 'api' } });

describe('EventBus', () => {
  let queue: InMemoryJobQueue;
  let bus: EventBus;

  beforeEach(() => {
    queue = new InMemoryJobQueue();
    bus = new EventBus(queue);
  });

  it('delivers an event to every consumer of its type', async () => {
    const audit = vi.fn(async () => {});
    const notifications = vi.fn(async () => {});
    await bus.subscribe(contractFor('ApplicationCreated'), 'audit', audit);
    await bus.subscribe(contractFor('ApplicationCreated'), 'notifications', notifications);

    await bus.publish(event);
    await queue.drain();

    expect(audit).toHaveBeenCalledWith(event);
    expect(notifications).toHaveBeenCalledWith(event);
  });

  it('does not deliver other event types', async () => {
    const handler = vi.fn(async () => {});
    await bus.subscribe(contractFor('ApplicationDeleted'), 'audit', handler);

    await bus.publish(event);
    await queue.drain();

    expect(handler).not.toHaveBeenCalled();
  });

  it("runs handlers in the event's company context", async () => {
    let seen: string | undefined;
    await bus.subscribe(contractFor('ApplicationCreated'), 'audit', async () => {
      seen = currentCompanyId();
    });

    await bus.publish(event);
    await queue.drain();

    expect(seen).toBe(companyId);
  });

  it('does not deliver the same event twice to a consumer', async () => {
    const handler = vi.fn(async () => {});
    await bus.subscribe(contractFor('ApplicationCreated'), 'audit', handler);

    await bus.publish(event);
    await bus.publish(event);
    await queue.drain();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps a failing consumer from affecting another', async () => {
    const healthy = vi.fn(async () => {});
    await bus.subscribe(contractFor('ApplicationCreated'), 'broken', async () => {
      throw new Error('Failure');
    });
    await bus.subscribe(contractFor('ApplicationCreated'), 'healthy', healthy);

    await bus.publish(event);
    await queue.drain();

    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('delivers every event type to a consumer of all events', async () => {
    const seen: string[] = [];
    await bus.subscribeToAll('audit', async (received) => void seen.push(received.eventType));
    await bus.subscribe(contractFor('ApplicationCreated'), 'other', async () => {});

    await bus.publish(event);
    await bus.publish(createDomainEvent({ eventType: 'SomethingNew', companyId, payload: {} }));
    await queue.drain();

    expect(seen).toEqual(['ApplicationCreated', 'SomethingNew']);
  });

  it("runs a consumer of all events in each event's company context", async () => {
    let seen: string | undefined;
    await bus.subscribeToAll('audit', async () => {
      seen = currentCompanyId();
    });

    await bus.publish(event);
    await queue.drain();

    expect(seen).toBe(companyId);
  });

  it('delivers events published in another process, which shares only the job queue', async () => {
    const handler = vi.fn(async () => {});
    await bus.subscribe(contractFor('ApplicationCreated'), 'audit', handler);
    // Another API instance, or another service, that has no subscriptions of its own.
    const publisher = new EventBus(queue);

    await publisher.publish(event);
    await queue.drain();

    expect(handler).toHaveBeenCalledWith(event);
  });

  it('sends an event without a valid company to the dead letter queue, without trying it again', async () => {
    const handler = vi.fn(async () => {});
    await bus.subscribe(contractFor('ApplicationCreated'), 'audit', handler);
    const broken = { ...event, companyId: 'not-a-company' } as unknown as typeof event;

    await bus.publish(broken);
    await queue.drain();

    expect(handler).not.toHaveBeenCalled();
    expect(queue.deadLettersOf('events.audit.ApplicationCreated')).toHaveLength(1);
  });

  it("sends an event that doesn't hold to its contract to the dead letter queue, and never to the handler", async () => {
    const handler = vi.fn(async () => {});
    const requiresName = contractFor('ApplicationCreated', (payload) => {
      if (typeof payload['name'] !== 'string') {
        throw new Error('name is missing');
      }
    });
    await bus.subscribe(requiresName, 'search', handler);

    await bus.publish(createDomainEvent({ eventType: 'ApplicationCreated', companyId, payload: {} }));
    await queue.drain();

    expect(handler).not.toHaveBeenCalled();
    expect(queue.deadLettersOf('events.search.ApplicationCreated')).toHaveLength(1);
  });

  it('delivers each version of an event type only to consumers of that version', async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    await bus.subscribe(contractFor('ApplicationCreated'), 'search', first);
    await bus.subscribe(contractFor('ApplicationCreated', () => {}, 2), 'search', second);
    const newer = createDomainEvent({ eventType: 'ApplicationCreated', eventVersion: 2, companyId, payload: { title: 'api' } });

    await bus.publish(event);
    await bus.publish(newer);
    await queue.drain();

    expect(first.mock.calls).toEqual([[event]]);
    expect(second.mock.calls).toEqual([[newer]]);
  });

  it('rejects a duplicate subscription', async () => {
    await bus.subscribe(contractFor('ApplicationCreated'), 'audit', async () => {});
    await bus.subscribeToAll('history', async () => {});

    await expect(bus.subscribe(contractFor('ApplicationCreated'), 'audit', async () => {})).rejects.toThrow('already subscribes');
    await expect(bus.subscribeToAll('history', async () => {})).rejects.toThrow('already subscribes to every event');
  });

  it('refuses a consumer name that is not in kebab-case, which names its queues', async () => {
    await expect(bus.subscribe(contractFor('ApplicationCreated'), 'Audit Log', async () => {})).rejects.toThrow('kebab-case');
    await expect(bus.subscribeToAll('audit_log', async () => {})).rejects.toThrow('kebab-case');
  });

  it("passes on a contract's own unrecoverable error as it is", async () => {
    const handler = vi.fn(async () => {});
    const refusing = contractFor('ApplicationCreated', () => {
      throw new UnrecoverableJobError('This consumer never takes these.');
    });
    await bus.subscribe(refusing, 'search', handler);

    await bus.publish(event);
    await queue.drain();

    expect(handler).not.toHaveBeenCalled();
    expect(queue.deadLettersOf('events.search.ApplicationCreated')).toHaveLength(1);
  });
});
