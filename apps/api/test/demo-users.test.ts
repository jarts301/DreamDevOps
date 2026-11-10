import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEMO_USERS } from '../src/demo/demo-company.ts';
import { loadConfig } from '../src/config/app-config.ts';

const KEYCLOAK_INIT = readFileSync(new URL('../../../infra/local/ops/keycloak-init.sh', import.meta.url), 'utf8');

describe('demo users', () => {
  it('have the same fixed IDs in Keycloak and in the demo company setup', () => {
    const inKeycloak = [...KEYCLOAK_INIT.matchAll(/^\s+"([0-9a-f-]{36})\|(demo-[a-z-]+)\|/gm)].map(([, id, username]) => ({
      subject: id,
      username,
    }));

    expect(inKeycloak).toEqual(DEMO_USERS.map(({ subject, username }) => ({ subject, username })));
  });

  it('cover the platform admin and every company role', () => {
    expect(DEMO_USERS.map((user) => user.role)).toEqual([null, 'company-admin', 'tech-lead', 'developer', 'operator', 'viewer']);
  });
});
