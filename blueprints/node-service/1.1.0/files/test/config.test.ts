import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('configuration', () => {
  it('uses port 8080 on every network interface by default', () => {
    expect(loadConfig({})).toEqual({ host: '0.0.0.0', port: 8080 });
  });

  it('refuses a port that is not valid', () => {
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow('PORT must be a whole number');
  });
});
