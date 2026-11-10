import { createDomainEvent, parseCompanyId } from '@dreamdevops/shared-kernel';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  environmentSlug,
  normalizeEnvironmentName,
  parseVersion,
  assertCurrentVersion,
} from '../src/environments/domain/environment.ts';
import { EnvironmentError } from '../src/environments/domain/errors.ts';
import { findProvider, HOSTING_PROVIDERS, parseSettings } from '../src/environments/domain/hosting-providers.ts';
import { authorizeChange, type ProtectedChange } from '../src/environments/domain/protection.ts';
import { summarize } from '../src/notifications/domain/event-catalog.ts';
import { COMPANY_A } from './fakes.ts';
import { signIn } from './support/integration.ts';
import { createTestApp } from './test-app.ts';

const provider = (key: string) => findProvider(key)!;
const exampleSettings = (key: string) =>
  Object.fromEntries(provider(key).settings.map((setting) => [setting.key, setting.example]));

describe('hosting providers', () => {
  it('offer self-hosted and cloud choices, each with a stable, unique key', () => {
    const keys = HOSTING_PROVIDERS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(['local', 'kubernetes', 'docker', 'aws', 'azure', 'gcp']);
    // The platform deploys only to this machine so far. The others can be planned for.
    expect(HOSTING_PROVIDERS.filter((entry) => entry.deploys).map((entry) => entry.key)).toEqual(['local']);
    expect(new Set(HOSTING_PROVIDERS.map((entry) => entry.kind))).toEqual(new Set(['self-hosted', 'cloud']));
    for (const entry of HOSTING_PROVIDERS) {
      expect(entry.key).toMatch(/^[a-z][a-z0-9-]{1,39}$/);
      expect(new Set(entry.settings.map((setting) => setting.key)).size).toBe(entry.settings.length);
    }
  });

  it.each(HOSTING_PROVIDERS.map((entry) => entry.key))('accept the example they show people: %s', (key) => {
    expect(() => parseSettings(provider(key), exampleSettings(key))).not.toThrow();
  });

  it('clean up settings, and fill in defaults', () => {
    expect(parseSettings(provider('kubernetes'), { apiServerUrl: ' https://k8s.example.com:6443/ ' })).toEqual({
      apiServerUrl: 'https://k8s.example.com:6443',
    });
    expect(parseSettings(provider('docker'), { host: 'Docker-01.Example.com' })).toEqual({
      host: 'docker-01.example.com',
      sshPort: 22,
    });
    expect(parseSettings(provider('docker'), { host: '10.0.0.5', sshPort: '2222' })).toEqual({ host: '10.0.0.5', sshPort: 2222 });
  });

  it.each([
    ['kubernetes', { apiServerUrl: 'http://k8s.example.com' }, "The API server address isn't valid"],
    ['kubernetes', { apiServerUrl: 'https://user:secret@k8s.example.com' }, "The API server address isn't valid"],
    ['kubernetes', {}, 'Enter the API server address.'],
    ['kubernetes', { apiServerUrl: 'https://k8s.example.com', ingressDomain: 'not a domain' }, "The domain for applications isn't valid"],
    ['docker', { host: 'docker-01.example.com', sshPort: 70000 }, "The SSH port isn't valid"],
    ['aws', { accountId: '1234', region: 'eu-west-1' }, "The account ID isn't valid"],
    ['aws', { accountId: '123456789012', region: 'Europe' }, "The region isn't valid"],
    ['gcp', { projectId: 'ok-project', region: 'europe-west1', token: 'x' }, 'Google Cloud has no setting named token.'],
  ])('refuse %s settings %j', (key, settings, message) => {
    expect(() => parseSettings(provider(key), settings)).toThrow(message);
  });

  it('are found only by their exact key', () => {
    expect(findProvider('aws')?.name).toBe('Amazon Web Services');
    expect(findProvider('AWS')).toBeNull();
    expect(findProvider(undefined)).toBeNull();
  });
});

describe('environment names', () => {
  it('are cleaned up, and make short names for infrastructure', () => {
    expect(normalizeEnvironmentName('  User   Acceptance ')).toBe('User Acceptance');
    expect(environmentSlug('User Acceptance Testing For Q3 Customers')).toHaveLength(30);
    expect(environmentSlug('Staging', 2)).toBe('staging-2');
    expect(() => normalizeEnvironmentName('x')).toThrow('Enter an environment name between 2 and 40 characters.');
  });
});

describe('versions', () => {
  it('must be given, and must be the current one', () => {
    expect(parseVersion(3)).toBe(3);
    for (const value of [undefined, 0, '3', 1.5]) {
      expect(() => parseVersion(value)).toThrow(EnvironmentError);
    }
    expect(() => assertCurrentVersion(2, 3)).toThrow('Someone else changed this meanwhile. Reload it and try again.');
  });
});

describe('production protection', () => {
  const production = { name: 'Production', production: true };
  const staging = { name: 'Staging', production: false };
  const reason = 'Customers need the new region.';
  const allowed = { canManageProduction: true, confirmation: 'Production', reason };

  it('leaves non-production environments to anyone who manages environments', () => {
    for (const change of ['create', 'rename', 'switch-target', 'archive', 'edit-target'] as ProtectedChange[]) {
      expect(authorizeChange(staging, change, { canManageProduction: false })).toBeNull();
    }
  });

  it('lets only people who manage production create it, or make an environment production', () => {
    expect(() => authorizeChange(production, 'create', { canManageProduction: false })).toThrow(
      'Only people who manage production can do this.',
    );
    expect(() => authorizeChange(staging, 'protect', { canManageProduction: false })).toThrow(EnvironmentError);
    expect(authorizeChange(production, 'create', { canManageProduction: true })).toBeNull();
    expect(authorizeChange(staging, 'protect', { canManageProduction: true, reason })).toBe(reason);
  });

  it.each(['rename', 'switch-target', 'unprotect', 'edit-target'] as ProtectedChange[])(
    'needs, for a %s of production, the permission, its name typed exactly, and a reason',
    (change) => {
      expect(authorizeChange(production, change, allowed)).toBe(reason);
      expect(() => authorizeChange(production, change, { ...allowed, canManageProduction: false })).toThrow(
        'Only people who manage production can do this.',
      );
      for (const confirmation of [undefined, '', 'production', 'Production ', 'Staging']) {
        expect(() => authorizeChange(production, change, { ...allowed, confirmation })).toThrow(
          'This affects production. To confirm, type its name exactly: Production',
        );
      }
      for (const missing of [undefined, '', 'Because']) {
        expect(() => authorizeChange(production, change, { ...allowed, reason: missing })).toThrow(EnvironmentError);
      }
    },
  );

  it('never archives production, even when confirmed', () => {
    expect(() => authorizeChange(production, 'archive', allowed)).toThrow(
      'Remove the production protection before archiving this environment.',
    );
  });

  it('refuses a reason that is too long, even when not needed', () => {
    expect(() => authorizeChange(staging, 'rename', { canManageProduction: false, reason: 'x'.repeat(501) })).toThrow(
      'Give a reason between 10 and 500 characters.',
    );
  });
});

describe('environment notifications', () => {
  const event = (eventType: string, payload: object) =>
    createDomainEvent({ eventType, companyId: parseCompanyId(COMPANY_A), payload });
  const environment = { name: 'Production', applicationName: 'Billing', production: true };

  it('say what happened to production, and why', () => {
    expect(summarize(event('EnvironmentUnprotected', { ...environment, reason: 'Moving to a new account.' }), 'Acme')).toBe(
      'Acme: The environment "Production" of "Billing" is no longer production: "Moving to a new account.".',
    );
    expect(summarize(event('EnvironmentTargetSwitched', { ...environment, reason: 'Moving to a new account.' }), 'Acme')).toBe(
      'Acme: The production environment "Production" of "Billing" moved to another hosting target: "Moving to a new account.".',
    );
    expect(summarize(event('EnvironmentCreated', { ...environment, production: false, name: 'Staging' }), 'Acme')).toBe(
      'Acme: The environment "Staging" of "Billing" was created.',
    );
    expect(summarize(event('HostingTargetUpdated', { name: 'AWS', servesProduction: true, reason: null }), 'Acme')).toBe(
      'Acme: The hosting target "AWS" changed, and production runs on it.',
    );
  });
});

describe('environment routes', () => {
  let app: INestApplication;
  const APPLICATION = '00000000-0000-4000-8000-0000000000aa';
  const ENVIRONMENT = '00000000-0000-4000-8000-0000000000bb';

  beforeAll(async () => {
    app = await createTestApp({ config: { secureCookies: false } });
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['get', '/api/v1/company/hosting-providers'],
    ['get', '/api/v1/company/hosting-targets'],
    ['post', '/api/v1/company/hosting-targets'],
    ['get', `/api/v1/company/applications/${APPLICATION}/environments`],
    ['post', `/api/v1/company/environments/${ENVIRONMENT}/unprotect`],
  ] as const)('ask anonymous users to sign in: %s %s', async (method, path) => {
    await request(app.getHttpServer())[method](path).expect(401);
  });

  it('let only people with the permissions change anything', async () => {
    // This sample member has none of the environment permissions.
    const member = await signIn(app, 'developer-a');

    await member.post('/api/v1/company/hosting-targets').send({}).expect(403);
    await member.post(`/api/v1/company/applications/${APPLICATION}/environments`).send({}).expect(403);
    await member.patch(`/api/v1/company/environments/${ENVIRONMENT}`).send({}).expect(403);
    await member.post(`/api/v1/company/environments/${ENVIRONMENT}/protect`).send({}).expect(403);
    await member.post(`/api/v1/company/environments/${ENVIRONMENT}/archive`).send({}).expect(403);
  });

  it('show every member the providers and their settings', async () => {
    const member = await signIn(app, 'developer-a');

    const { body } = await member.get('/api/v1/company/hosting-providers').expect(200);

    expect(body.map((entry: { key: string }) => entry.key)).toEqual(['local', 'kubernetes', 'docker', 'aws', 'azure', 'gcp']);
    expect(body[3].settings[0]).toMatchObject({ key: 'accountId', required: true, example: '123456789012' });
  });

  it('leave out this machine on a server that doesn’t allow running applications on it', async () => {
    const closed = await createTestApp({ config: { secureCookies: false, localHosting: false } });
    try {
      const member = await signIn(closed, 'developer-a');

      const { body } = await member.get('/api/v1/company/hosting-providers').expect(200);

      expect(body.map((entry: { key: string }) => entry.key)).toEqual(['kubernetes', 'docker', 'aws', 'azure', 'gcp']);
    } finally {
      await closed.close();
    }
  });
});
