import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDomainEvent, currentCompanyId, EventBus, parseCompanyId } from '../src/index.ts';
import { InMemoryJobQueue } from '../src/testing/index.ts';

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
    await bus.subscribe('ApplicationCreated', 'audit', audit);
    await bus.subscribe('ApplicationCreated', 'notifications', notifications);

    await bus.publish(event);
    await queue.drain();

    expect(audit).toHaveBeenCalledWith(event);
    expect(notifications).toHaveBeenCalledWith(event);
  });

  it('does not deliver other event types', async () => {
    const handler = vi.fn(async () => {});
    await bus.subscribe('ApplicationDeleted', 'audit', handler);

    await bus.publish(event);
    await queue.drain();

    expect(handler).not.toHaveBeenCalled();
  });

  it("runs handlers in the event's company context", async () => {
    let seen: string | undefined;
    await bus.subscribe('ApplicationCreated', 'audit', async () => {
      seen = currentCompanyId();
    });

    await bus.publish(event);
    await queue.drain();

    expect(seen).toBe(companyId);
  });

  it('does not deliver the same event twice to a consumer', async () => {
    const handler = vi.fn(async () => {});
    await bus.subscribe('ApplicationCreated', 'audit', handler);

    await bus.publish(event);
    await bus.publish(event);
    await queue.drain();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps a failing consumer from affecting another', async () => {
    const healthy = vi.fn(async () => {});
    await bus.subscribe('ApplicationCreated', 'broken', async () => {
      throw new Error('Failure');
    });
    await bus.subscribe('ApplicationCreated', 'healthy', healthy);

    await bus.publish(event);
    await queue.drain();

    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('delivers every event type to a consumer of all events', async () => {
    const seen: string[] = [];
    await bus.subscribeToAll('audit', async (received) => void seen.push(received.eventType));
    await bus.subscribe('ApplicationCreated', 'other', async () => {});

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

  it('rejects a duplicate subscription', async () => {
    await bus.subscribe('ApplicationCreated', 'audit', async () => {});

    await expect(bus.subscribe('ApplicationCreated', 'audit', async () => {})).rejects.toThrow('already subscribes');
  });
});
