import { describe, expect, it } from 'vitest';
import { deterministicJobId, isUuid } from '../src/index.ts';

describe('deterministicJobId', () => {
  it('gives the same UUID for the same parts, so a job is queued once however often it is asked for', () => {
    const id = deterministicJobId('alerts.email', 'event-1', 'user-1');

    expect(isUuid(id)).toBe(true);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicJobId('alerts.email', 'event-1', 'user-1')).toBe(id);
  });

  it('gives different parts different IDs', () => {
    expect(deterministicJobId('alerts.email', 'event-1', 'user-2')).not.toBe(deterministicJobId('alerts.email', 'event-1', 'user-1'));
    expect(deterministicJobId('a', 'b:c')).not.toBe(deterministicJobId('a:b', 'd'));
  });
});
