import { describe, expect, it } from 'vitest';
import { registerOnce, tokenOf, withOverrides } from '../src/platform/module-settings.ts';
import { testConfig } from './test-app.ts';

const TOKEN = Symbol('TOKEN');
class Service {}

describe('module settings', () => {
  it('replace a module’s providers by token, the last replacement winning, as when registered in order', () => {
    const replaced = withOverrides(
      [{ provide: TOKEN, useValue: 'real' }, Service],
      [
        { provide: TOKEN, useValue: 'first fake' },
        { provide: TOKEN, useValue: 'second fake' },
        { provide: Symbol('elsewhere'), useValue: 'ignored here' },
      ],
    );

    expect(replaced).toEqual([{ provide: TOKEN, useValue: 'second fake' }, Service]);
    expect(tokenOf(Service)).toBe(Service);
  });

  it('give every import of a module the same definition, so Nest creates it once', () => {
    const settings = { config: testConfig(), overrides: [] };
    let built = 0;
    const build = () => {
      built += 1;
      return { module: Service };
    };

    const first = registerOnce(settings, Service, build);
    const second = registerOnce(settings, Service, build);
    const other = registerOnce({ ...settings }, Service, build);

    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(built).toBe(2);
  });
});
