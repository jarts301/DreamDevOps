import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('listens on port 3000 without a database by default', () => {
    expect(loadConfig({})).toEqual({ port: 3000, databaseUrl: null });
  });

  it('reads the port and database', () => {
    expect(
      loadConfig({ PORT: '8080', DATABASE_URL: 'postgres://app@db/app' }),
    ).toEqual({
      port: 8080,
      databaseUrl: 'postgres://app@db/app',
    });
  });

  it.each(['abc', '0', '70000', '80.5'])('refuses the port %s', (port) => {
    expect(() => loadConfig({ PORT: port })).toThrow('PORT');
  });

  it('refuses a database address that is not a URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'not a url' })).toThrow(
      'DATABASE_URL',
    );
  });
});
