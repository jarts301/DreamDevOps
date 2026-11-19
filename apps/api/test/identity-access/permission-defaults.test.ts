import { describe, expect, it } from 'vitest';
import { PermissionDefaults } from '../../src/identity-access/application/permission-defaults.ts';
import { FakePermissionStore, RecordingLogger } from '../fakes.ts';

describe('permission defaults', () => {
  const declared = [
    { permission: 'releases:start', roles: ['tech-lead'] },
    { permission: 'alerts:manage', roles: ['company-admin', 'operator'] },
  ];

  it('give each role the permissions declared for it, and say which were new', async () => {
    const store = new FakePermissionStore();
    const logger = new RecordingLogger();

    const added = await new PermissionDefaults(store, declared, logger).apply();

    expect(added).toEqual([
      { role: 'tech-lead', permission: 'releases:start' },
      { role: 'company-admin', permission: 'alerts:manage' },
      { role: 'operator', permission: 'alerts:manage' },
    ]);
    expect(logger.lines).toEqual([
      'log: Gave roles their new permissions: releases:start to tech-lead, alerts:manage to company-admin, alerts:manage to operator.',
    ]);
  });

  it('add only what is missing, and say nothing when nothing is', async () => {
    const store = new FakePermissionStore();
    store.granted.add('tech-lead releases:start');
    const logger = new RecordingLogger();
    const defaults = new PermissionDefaults(store, declared, logger);

    expect(await defaults.apply()).toHaveLength(2);
    expect(await defaults.apply()).toEqual([]);
    expect(logger.lines).toHaveLength(1);
  });
});
