import { describe, expect, it } from 'vitest';
import { AggregateRoot, createDomainEvent, InvalidDomainEventError, parseCompanyId } from '../src/index.ts';

const companyId = parseCompanyId('a1b2c3d4-0000-4000-8000-000000000001');

describe('createDomainEvent', () => {
  it('fills in the ID, version and time', () => {
    const event = createDomainEvent({ eventType: 'ApplicationCreated', companyId, payload: { name: 'api' } });

    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.eventVersion).toBe(1);
    expect(new Date(event.occurredAt).toISOString()).toBe(event.occurredAt);
    expect(event.payload).toEqual({ name: 'api' });
    expect(event.actorId).toBeNull();
  });

  it('records who caused it', () => {
    const event = createDomainEvent({ eventType: 'ApplicationCreated', companyId, actorId: 'user-7', payload: {} });

    expect(event.actorId).toBe('user-7');
  });

  it('gives each event its own ID', () => {
    const first = createDomainEvent({ eventType: 'ApplicationCreated', companyId, payload: {} });
    const second = createDomainEvent({ eventType: 'ApplicationCreated', companyId, payload: {} });

    expect(first.eventId).not.toBe(second.eventId);
  });

  it('cannot be changed after creation', () => {
    const event = createDomainEvent({ eventType: 'ApplicationCreated', companyId, payload: {} });

    expect(() => {
      (event as { eventType: string }).eventType = 'Changed';
    }).toThrow(TypeError);
  });

  it.each(['applicationCreated', 'application.created', ''])('rejects the event type %j', (eventType) => {
    expect(() => createDomainEvent({ eventType, companyId, payload: {} })).toThrow(InvalidDomainEventError);
  });

  it.each([0, -1, 1.5])('rejects the version %d', (eventVersion) => {
    expect(() => createDomainEvent({ eventType: 'A', eventVersion, companyId, payload: {} })).toThrow(
      InvalidDomainEventError,
    );
  });
});

describe('AggregateRoot', () => {
  class Sample extends AggregateRoot {
    rename(): void {
      this.record(createDomainEvent({ eventType: 'SampleRenamed', companyId, payload: {} }));
    }
  }

  it('hands over recorded events only once', () => {
    const sample = new Sample();
    sample.rename();
    sample.rename();

    expect(sample.pullEvents()).toHaveLength(2);
    expect(sample.pullEvents()).toHaveLength(0);
  });
});
