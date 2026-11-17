import { describe, expect, it } from 'vitest';
import { authorizeChange, type ProtectedChange } from '../src/environments/domain/protection.ts';

const production = { name: 'Production', production: true };
const staging = { name: 'Staging', production: false };
const manager = { canManageProduction: true };
const confirmed = { ...manager, confirmation: 'Production', reason: 'Moving to the new cluster' };

describe('production protection', () => {
  it('leaves other environments alone, but checks a reason given', () => {
    expect(authorizeChange(staging, 'disconnect-target', { canManageProduction: false })).toBeNull();
    expect(authorizeChange(staging, 'stop', { canManageProduction: false, reason: '  Not needed   any more ' })).toBe('Not needed any more');
    expect(() => authorizeChange(staging, 'stop', { canManageProduction: false, reason: 'short' })).toThrow(
      'Give a reason between 10 and 500 characters.',
    );
  });

  it('keeps changes to the production environment itself for those who manage it', () => {
    for (const change of ['create', 'rename', 'change-approval', 'archive', 'connect-target', 'disconnect-target'] as const) {
      expect(() => authorizeChange(production, change, { ...confirmed, canManageProduction: false }), change).toThrow(
        'Only Tech Leads and Operators manage production environments.',
      );
    }
    // Deploying and production's values have permissions of their own.
    expect(authorizeChange(production, 'deploy', { canManageProduction: false, confirmation: 'Production' })).toBeNull();
    expect(authorizeChange(production, 'change-variables', { ...confirmed, canManageProduction: false })).toBe('Moving to the new cluster');
  });

  it('needs no confirmation to add production, or connect where it runs', () => {
    expect(authorizeChange(production, 'create', manager)).toBeNull();
    expect(authorizeChange(production, 'connect-target', manager)).toBeNull();
  });

  it('needs the name typed exactly for anything else', () => {
    const changes: ProtectedChange[] = ['rename', 'archive', 'disconnect-target', 'change-variables', 'deploy', 'approve', 'promote', 'abort', 'rollback', 'stop', 'apply'];
    for (const change of changes) {
      for (const confirmation of [undefined, 'production', ' Production', 'Staging']) {
        expect(() => authorizeChange(production, change, { ...confirmed, confirmation }), `${change} ${confirmation}`).toThrow(
          'This affects production. To confirm, type its name exactly: Production',
        );
      }
    }
  });

  it('needs a reason for changes, but not for running or steering a version that was asked for', () => {
    for (const change of ['rename', 'archive', 'disconnect-target', 'change-variables', 'rollback', 'stop'] as const) {
      expect(() => authorizeChange(production, change, { ...manager, confirmation: 'Production' }), change).toThrow(
        "Say why you're changing production, in 10 to 500 characters.",
      );
    }
    for (const change of ['deploy', 'approve', 'promote', 'abort', 'apply'] as const) {
      expect(authorizeChange(production, change, { ...manager, confirmation: 'Production' }), change).toBeNull();
    }
    expect(authorizeChange(production, 'rollback', confirmed)).toBe('Moving to the new cluster');
  });
});
