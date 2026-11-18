import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IDENTITY_PROVIDER } from '../src/identity-access/application/ports.ts';
import { MAILER } from '../src/notifications/application/ports.ts';
import { GIT_PROVIDER } from '../src/tenancy/application/ports.ts';
import { FakeGitProvider, FakeIdentityProvider, FakeMailer } from './fakes.ts';
import { type Agent, eventually, signIn as signInAs, unique } from './support/integration.ts';
import { buildApp } from './test-app.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';

/**
 * Invitation emails and chat rules against a real database, with emails kept in memory.
 * The same flows against a real mail server are in audit-notifications.integration.test.ts.
 */

let database: TestDatabase;
let app: INestApplication;
let receiver: Server;
let receiverUrl: string;
const mailer = new FakeMailer();
const received: { path: string; body: Record<string, unknown> }[] = [];
let failingPaths = new Set<string>();

const signIn = (user: string) => signInAs(app, user);

/** The invitation link's token, read from the last email to an address, as the invited person would. */
const tokenSentTo = (address: string) => {
  const email = mailer.sent.filter((message) => message.to === address).at(-1);
  expect(email, `an email to ${address}`).toBeDefined();
  return decodeURIComponent(/#token=([^\s]+)/.exec(email!.text)![1]!);
};

/** A company whose first admin joins using only the link in their email. */
const createCompany = async () => {
  const platformAdmin = await signIn('platform-admin');
  const adminName = unique('admin');
  const name = unique('Company');
  const { body } = await platformAdmin.post('/api/v1/platform/companies').send({ name, firstAdminEmail: `${adminName}@example.com` }).expect(201);
  expect(body.invitation.emailSent).toBe(true);
  const admin = await signIn(adminName);
  await admin.post('/api/v1/invitations/accept').send({ token: tokenSentTo(`${adminName}@example.com`) }).expect(200);
  return { admin, name };
};

const addMember = async (admin: Agent, role: string) => {
  const name = unique('member');
  const { body } = await admin.post('/api/v1/company/invitations').send({ email: `${name}@example.com`, role }).expect(201);
  expect(body.emailSent).toBe(true);
  const member = await signIn(name);
  await member.post('/api/v1/invitations/accept').send({ token: tokenSentTo(`${name}@example.com`) }).expect(200);
  return member;
};

const createRule = async (admin: Agent, path: string, overrides: Record<string, unknown> = {}) =>
  (
    await admin
      .post('/api/v1/company/notification-rules')
      .send({ name: unique('Rule'), kind: 'generic', url: `${receiverUrl}${path}`, eventTypes: ['RoleGranted'], ...overrides })
      .expect(201)
  ).body as { id: string; destination: string; enabled: boolean };

const viewerJoined = (path: string) =>
  received.filter((item) => item.path === path && String(item.body.text).endsWith('joined as Viewer.'));

beforeAll(async () => {
  database = await startTestDatabase();
  receiver = createServer((incoming, response) => {
    let body = '';
    incoming.on('data', (chunk) => (body += chunk));
    incoming.on('end', () => {
      received.push({ path: incoming.url ?? '', body: JSON.parse(body || '{}') });
      response.writeHead(failingPaths.has(incoming.url ?? '') ? 500 : 200).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  app = await buildApp({
    background: true,
    config: {
      databaseUrl: database.urlFor('app'),
      relayDatabaseUrl: database.urlFor('relay'),
      jobsDatabaseUrl: database.urlFor('jobs'),
      secureCookies: false,
      dashboardUrl: 'http://dashboard.test/',
      webhookAllowInsecure: true,
      webhookAllowPrivateNetworks: true,
    },
    overrides: [
      { provide: IDENTITY_PROVIDER, useValue: new FakeIdentityProvider() },
      { provide: GIT_PROVIDER, useValue: new FakeGitProvider() },
      { provide: MAILER, useValue: mailer },
    ],
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  receiver?.close();
  await database?.stop();
});

beforeEach(() => {
  received.length = 0;
  failingPaths = new Set();
  mailer.failing = false;
});

describe('invitations', () => {
  it('are emailed with a link that lets the person in, saying who invited them to which company and role', async () => {
    const { admin, name } = await createCompany();
    const invited = unique('invited');

    await admin.post('/api/v1/company/invitations').send({ email: `${invited}@example.com`, role: 'tech-lead' }).expect(201);

    const email = mailer.sent.find((message) => message.to === `${invited}@example.com`)!;
    expect(email.subject).toBe(`You're invited to join ${name} on DreamDevOps`);
    expect(email.text).toContain(`invited you to join ${name} on DreamDevOps as Tech Lead.`);
    expect(email.text).toContain('http://dashboard.test/invitations/accept#token=');
  });

  it('still stand when the email fails, and say so, so the inviter sends the link', async () => {
    const { admin } = await createCompany();
    mailer.failing = true;

    const { body } = await admin.post('/api/v1/company/invitations').send({ email: `${unique('invited')}@example.com`, role: 'viewer' }).expect(201);

    expect(body).toMatchObject({ emailSent: false, token: expect.any(String) });
    expect((await admin.get('/api/v1/company/invitations').expect(200)).body).toHaveLength(1);
  });
});

describe('chat rules', () => {
  it('post chosen events to the webhook, with the company named', async () => {
    const { admin, name } = await createCompany();
    await createRule(admin, '/generic');

    await addMember(admin, 'viewer');

    await eventually(() => expect(viewerJoined('/generic')).toHaveLength(1));
    expect(viewerJoined('/generic')[0]!.body).toMatchObject({ text: `${name}: Someone joined as Viewer.`, eventType: 'RoleGranted', companyName: name });
  });

  it('skip events not chosen, and rules turned off', async () => {
    const { admin } = await createCompany();
    await createRule(admin, '/other-events', { eventTypes: ['CompanySuspended'] });
    const off = await createRule(admin, '/off');
    const { body: changed } = await admin.patch(`/api/v1/company/notification-rules/${off.id}`).send({ enabled: false }).expect(200);
    await createRule(admin, '/control');

    await addMember(admin, 'viewer');

    expect(changed).toMatchObject({ id: off.id, enabled: false, eventTypes: ['RoleGranted'] });
    await eventually(() => expect(viewerJoined('/control')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(new Set(received.map((item) => item.path))).toEqual(new Set(['/control']));
  });

  it('record a failing webhook, without affecting another', async () => {
    const { admin } = await createCompany();
    failingPaths.add('/broken');
    const broken = await createRule(admin, '/broken');
    await createRule(admin, '/healthy');

    await addMember(admin, 'viewer');

    await eventually(() => expect(viewerJoined('/healthy')).toHaveLength(1));
    await eventually(async () => {
      const { body } = await admin.get('/api/v1/company/notification-rules').expect(200);
      expect((body as { id: string; lastError: string | null }[]).find((rule) => rule.id === broken.id)?.lastError).toContain('status 500');
    });
  });

  it('send a test message on request, and show only the address’s origin', async () => {
    const { admin } = await createCompany();
    const rule = await createRule(admin, '/secret-path-abc123');

    const { body } = await admin.post(`/api/v1/company/notification-rules/${rule.id}/test`).expect(200);
    const { body: rules } = await admin.get('/api/v1/company/notification-rules').expect(200);

    expect(body).toEqual({ delivered: true, error: null });
    expect(received.map((item) => String(item.body.text))).toContainEqual(expect.stringContaining('This is a test message'));
    expect(rule.destination).toBe(receiverUrl);
    expect(JSON.stringify(rules)).not.toContain('secret-path-abc123');
  });

  it('belong to their company, which alone sees, changes and deletes them', async () => {
    const first = await createCompany();
    const second = await createCompany();
    const rule = await createRule(first.admin, '/first');

    expect((await second.admin.get('/api/v1/company/notification-rules').expect(200)).body).toEqual([]);
    await second.admin.patch(`/api/v1/company/notification-rules/${rule.id}`).send({ enabled: false }).expect(404);
    await second.admin.delete(`/api/v1/company/notification-rules/${rule.id}`).expect(404);
    await first.admin.delete(`/api/v1/company/notification-rules/${rule.id}`).expect(204);
    expect((await first.admin.get('/api/v1/company/notification-rules').expect(200)).body).toEqual([]);
  });
});
