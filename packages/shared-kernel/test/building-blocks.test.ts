import { describe, expect, it } from 'vitest';
import { describeError, DomainError, isUuid } from '../src/index.ts';

class SampleError extends DomainError<'invalid' | 'conflict'> {}

describe('domain errors', () => {
  it('carry a kind and a message people can read, named after their class', () => {
    const error = new SampleError('conflict', 'This name is taken.');

    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('conflict');
    expect(error.message).toBe('This name is taken.');
    expect(error.name).toBe('SampleError');
  });
});

describe('isUuid', () => {
  it('accepts UUIDs in either case, and nothing else', () => {
    expect(isUuid('00000000-0000-4000-8000-00000000000A')).toBe(true);
    for (const value of ['', 'not-a-uuid', '00000000-0000-4000-8000-00000000000', 42, null, undefined]) {
      expect(isUuid(value)).toBe(false);
    }
  });
});

describe('describeError', () => {
  it('keeps messages short, and says nothing about what isn’t an Error', () => {
    expect(describeError(new Error('x'.repeat(400)))).toHaveLength(300);
    expect(describeError(new Error('Refused'))).toBe('Refused');
    expect(describeError('a string')).toBe('Unknown error');
  });
});
