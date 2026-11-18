import { describe, expect, it } from 'vitest';
import { createDomainEvent, InvalidEventPayloadError, parseCompanyId, payloadOf, UnrecoverableJobError } from '../src/index.ts';

const companyId = parseCompanyId('a1b2c3d4-0000-4000-8000-00000000000a');
const event = (payload: object) => createDomainEvent({ eventType: 'BuildFinished', companyId, payload });

describe('reading an event payload', () => {
  it('reads text, optional text and flags', () => {
    const payload = payloadOf(event({ buildId: 'b1', reason: 'broken', releaseId: null, passed: true }));

    expect(payload.text('buildId')).toBe('b1');
    expect(payload.optionalText('reason')).toBe('broken');
    expect(payload.optionalText('releaseId')).toBeNull();
    expect(payload.optionalText('missing')).toBeNull();
    expect(payload.optionalFlag('passed')).toBe(true);
    expect(payload.optionalFlag('missing')).toBe(false);
  });

  it.each([
    ['missing', {}],
    ['empty', { buildId: '' }],
    ['a number', { buildId: 7 }],
  ])('refuses a required field that is %s, so the event is not tried again', (_case, fields) => {
    const read = () => payloadOf(event(fields)).text('buildId');

    expect(read).toThrow(InvalidEventPayloadError);
    expect(read).toThrow(UnrecoverableJobError);
    expect(read).toThrow('no valid "buildId"');
  });

  it('refuses optional fields of the wrong kind', () => {
    const payload = payloadOf(event({ reason: 3, passed: 'yes' }));

    expect(() => payload.optionalText('reason')).toThrow(InvalidEventPayloadError);
    expect(() => payload.optionalFlag('passed')).toThrow(InvalidEventPayloadError);
  });
});
