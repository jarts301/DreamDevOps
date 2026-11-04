import { describe, expect, it } from 'vitest';
import { InvalidCompanyIdError, parseCompanyId } from '../src/index.ts';

describe('parseCompanyId', () => {
  it('accepts a UUID and normalizes its case', () => {
    expect(parseCompanyId('A1B2C3D4-0000-4000-8000-000000000001')).toBe('a1b2c3d4-0000-4000-8000-000000000001');
  });

  it.each(['', 'company-1', "' OR 1=1 --", 'a1b2c3d4-0000-4000-8000-00000000000'])('rejects %j', (value) => {
    expect(() => parseCompanyId(value)).toThrow(InvalidCompanyIdError);
  });
});
