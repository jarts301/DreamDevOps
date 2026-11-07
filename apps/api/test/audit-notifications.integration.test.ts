import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { createDomainEvent, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../src/audit/application/audit-log.ts';
import { IDENTITY_PROVIDER } from '../src/identity-access/application/ports.ts';
import { MAILER } from '../src/notifications/application/ports.ts';
import { SmtpMailer } from '../src/notifications/infrastructure/smtp-mailer.ts';
import { GIT_PROVIDER } from '../src/tenancy/application/ports.ts';
import { FakeGitProvider, FakeIdentityProvider } from './fakes.ts';
import { buildApp } from './test-app.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';

let database: TestDatabase;
let ownerPool: pg.Pool;
let mailpit: StartedTestContainer;
let mailpitApi: string;
let app: INestApplication;
let receiver: Server;
let receiverUrl: string;
const received: { path: string; body: Record<string, unknown> }[] = [];
let failingPaths = new Set<string>();

const eventually = (assertion: () => Promise<void> | void) => vi.waitFor(assertion, { timeout: 20_000, interval: 150 });

const signIn = async (user: string) => {
  const agent = request.agent(app.getHttpServer());
  const login = await agent.get(`/api/v1/auth/login?login_hint=${user}`).expect(302);
  const callback = new URL(login.headers.location as string);
  await agent.get(callback.pathname + callback.search).expect(302);
  return agent;
};

let counter = 0;
const unique = (prefix: string) => {
  counter += 1;
  return `${prefix}-${'abcdefghijklmnopqrstuvwxyz'[Math.floor(counter / 26) % 26]}${'abcdefghijklmnopqrstuvwxyz'[counter % 26]}`;
};

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

const emailsTo = async (address: string) => {
  const response = await fetch(`${mailpitApi}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
  return ((await response.json()) as { messages: MailpitMessage[] }).messages;
};

const textOf = async (id: string) => {
  const response = await fetch(`${mailpitApi}/api/v1/message/${id}`);
  return ((await response.json()) as { Text: string }).Text;
};

/** Reads the invitation token from the email, as the invited person would. */
const tokenFromEmail = async (address: string) => {
  let messages: MailpitMessage[] = [];
  await eventually(async () => {
    messages = await emailsTo(address);
    expect(messages).toHaveLength(1);
  });
  const text = await textOf(messages[0]!.ID);
  return decodeURIComponent(/#token=([^\s]+)/.exec(text)![1]!);
};

/** Creates a company whose first admin joins using only the link in their email. */
const createCompany = async () => {
  const platformAdmin = await signIn('platform-admin');
  const adminName = unique('admin');
  const name = unique('Company');
  const { body } = await platformAdmin
    .post('/api/v1/platform/companies')
    .send({ name, firstAdminEmail: `${adminName}@example.com` })
    .expect(201);
  expect(body.invitation.emailSent).toBe(true);
  const token = await tokenFromEmail(`${adminName}@example.com`);
  const admin = await signIn(adminName);
  await admin.post('/api/v1/invitations/accept').send({ token }).expect(200);
  return { platformAdmin, admin, adminName, companyId: body.company.id as string, name };
};

const addMember = async (admin: Awaited<ReturnType<typeof signIn>>, role: string) => {
  const name = unique('member');
  const { body } = await admin
    .post('/api/v1/company/invitations')
    .send({ email: `${name}@example.com`, role })
    .expect(201);
  expect(body.emailSent).toBe(true);
  const member = await signIn(name);
  await member.post('/api/v1/invitations/accept').send({ token: await tokenFromEmail(`${name}@example.com`) }).expect(200);
  const me = await member.get('/api/v1/auth/me').expect(200);
  return { agent: member, userId: me.body.userId as string, name };
};

const auditOf = async (admin: Awaited<ReturnType<typeof signIn>>) =>
  (await admin.get('/api/v1/company/audit').expect(200)).body as {
    entries: { sequence: number; eventType: string; actor: { displayName: string } | null; payload: object }[];
  };

beforeAll(async () => {
  [database, mailpit] = await Promise.all([
    startTestDatabase(),
    new GenericContainer('axllent/mailpit:v1.33.0')
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forHttp('/readyz', 8025))
      .start(),
  ]);
  mailpitApi = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`;
  ownerPool = new pg.Pool({ connectionString: database.urlFor('owner') });

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
      {
        provide: MAILER,
        useValue: new SmtpMailer({
          host: mailpit.getHost(),
          port: mailpit.getMappedPort(1025),
          from: 'DreamDevOps <no-reply@example.com>',
          security: 'none',
          username: null,
          password: null,
        }),
      },
    ],
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  receiver?.close();
  await ownerPool?.end();
  await Promise.all([database?.stop(), mailpit?.stop()]);
});

beforeEach(() => {
  received.length = 0;
  failingPaths = new Set();
});

describe('invitation emails', () => {
  it('send the first admin a link that lets them in', async () => {
    const { admin, name } = await createCompany();

    await expect(admin.get('/api/v1/auth/me')).resolves.toMatchObject({ body: { companyName: name } });
  });

  it('say who invited them, to which company and role', async () => {
    const { admin, name } = await createCompany();
    const invited = unique('invited');

    await admin.post('/api/v1/company/invitations').send({ email: `${invited}@example.com`, role: 'tech-lead' });

    await eventually(async () => expect(await emailsTo(`${invited}@example.com`)).toHaveLength(1));
    const [message] = await emailsTo(`${invited}@example.com`);
    expect(message!.Subject).toBe(`You're invited to join ${name} on DreamDevOps`);
    const text = await textOf(message!.ID);
    expect(text).toContain(`invited you to join ${name} on DreamDevOps as Tech Lead.`);
    expect(text).toContain('http://dashboard.test/invitations/accept#token=');
  });
});

describe('the audit log', () => {
  it('records each change, newest first, with who made it', async () => {
    const { admin, adminName } = await createCompany();
    const member = await addMember(admin, 'viewer');
    await admin.patch(`/api/v1/company/members/${member.userId}`).send({ role: 'developer' }).expect(204);

    // Entries are numbered in the order they're recorded, which background delivery doesn't
    // keep, but the list is sorted by when each change happened.
    await eventually(async () => expect((await auditOf(admin)).entries).toHaveLength(7));
    const { entries } = await auditOf(admin);
    const times = entries.map((entry) => Date.parse((entry as unknown as { occurredAt: string }).occurredAt));
    expect(times).toEqual([...times].sort((left, right) => right - left));
    const byType = (type: string) => entries.filter((entry) => entry.eventType === type);
    expect(entries.map((entry) => entry.eventType).sort()).toEqual(
      ['CompanyCreated', 'CompanyProvisioned', 'RoleGranted', 'RoleGranted', 'RoleGranted', 'UserInvited', 'UserInvited'].sort(),
    );
    expect(entries.map((entry) => entry.sequence).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(entries.at(-1)).toMatchObject({ eventType: 'CompanyCreated', actor: { displayName: 'platform-admin' } });
    expect(byType('CompanyProvisioned')[0]!.actor).toBeNull();
    expect(byType('RoleGranted')[0]).toMatchObject({ actor: { displayName: adminName }, payload: { role: 'developer' } });
  });

  it('verifies as intact', async () => {
    const { admin } = await createCompany();
    await eventually(async () => expect((await auditOf(admin)).entries.length).toBeGreaterThanOrEqual(4));

    const { body } = await admin.get('/api/v1/company/audit/verify').expect(200);

    expect(body).toMatchObject({ valid: true, brokenAtSequence: null });
    expect(body.checked).toBeGreaterThanOrEqual(4);
  });

  it('records an event delivered twice only once', async () => {
    const { admin, companyId } = await createCompany();
    await eventually(async () => expect((await auditOf(admin)).entries.length).toBeGreaterThanOrEqual(4));
    const log = app.get(AuditLog);
    const event = createDomainEvent({ eventType: 'MemberRemoved', companyId: parseCompanyId(companyId), payload: {} });

    await runWithCompany(parseCompanyId(companyId), () => log.record(event));
    await runWithCompany(parseCompanyId(companyId), () => log.record(event));

    const { entries } = await auditOf(admin);
    expect(entries.filter((entry) => entry.eventType === 'MemberRemoved')).toHaveLength(1);
    await expect(admin.get('/api/v1/company/audit/verify')).resolves.toMatchObject({ body: { valid: true } });
  });

  it('refuses changes and deletions, even from the table owner', async () => {
    const { admin, companyId } = await createCompany();
    await eventually(async () => expect((await auditOf(admin)).entries.length).toBeGreaterThanOrEqual(4));

    await expect(
      ownerPool.query("UPDATE audit.entries SET payload = '{}' WHERE company_id = $1", [companyId]),
    ).rejects.toThrow('cannot be changed');
    await expect(ownerPool.query('DELETE FROM audit.entries WHERE company_id = $1', [companyId])).rejects.toThrow(
      'cannot be changed',
    );
    await expect(ownerPool.query('TRUNCATE audit.entries')).rejects.toThrow('cannot be changed');
  });

  it('exposes tampering by someone who gets around the protection', async () => {
    const { admin, companyId } = await createCompany();
    await eventually(async () => expect((await auditOf(admin)).entries.length).toBeGreaterThanOrEqual(4));

    const client = await ownerPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE audit.entries DISABLE TRIGGER entries_append_only');
      await client.query(
        `UPDATE audit.entries SET payload = '{"role": "company-admin"}' WHERE company_id = $1 AND sequence = 2`,
        [companyId],
      );
      await client.query('ALTER TABLE audit.entries ENABLE TRIGGER entries_append_only');
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const { body } = await admin.get('/api/v1/company/audit/verify').expect(200);
    expect(body).toMatchObject({ valid: false, brokenAtSequence: 2, checked: 1 });
  });

  it("shows a company only its own history", async () => {
    const first = await createCompany();
    const second = await createCompany();
    await eventually(async () => expect((await auditOf(first.admin)).entries.length).toBeGreaterThanOrEqual(4));

    const { entries } = await auditOf(second.admin);

    expect(JSON.stringify(entries)).not.toContain(first.name);
  });

  it('is readable only with the audit permission', async () => {
    const { admin, platformAdmin } = await createCompany();
    const developer = await addMember(admin, 'developer');

    await developer.agent.get('/api/v1/company/audit').expect(403);
    await developer.agent.get('/api/v1/company/audit/verify').expect(403);
    await platformAdmin.get('/api/v1/company/audit').expect(403);
  });

  it("shows a platform admin their own actions across companies", async () => {
    const first = await createCompany();
    const second = await createCompany();

    await eventually(async () => {
      const { body } = await first.platformAdmin.get('/api/v1/platform/audit').expect(200);
      const names = (body.entries as { companyName: string; eventType: string }[])
        .filter((entry) => entry.eventType === 'CompanyCreated')
        .map((entry) => entry.companyName);
      expect(names).toEqual(expect.arrayContaining([first.name, second.name]));
    });
    await first.admin.get('/api/v1/platform/audit').expect(403);
  });
});

describe('chat notifications', () => {
  // Rules apply to events as they're delivered, so a rule made just after a change can
  // also receive it. Each test looks for its own message rather than counting all of them.
  const viewerJoined = (path: string) =>
    received.filter((item) => item.path === path && String(item.body.text).endsWith('joined as Viewer.'));

  const createRule = async (
    admin: Awaited<ReturnType<typeof signIn>>,
    path: string,
    overrides: Record<string, unknown> = {},
  ) =>
    (
      await admin
        .post('/api/v1/company/notification-rules')
        .send({ name: `Rule ${received.length + 1}`, kind: 'generic', url: `${receiverUrl}${path}`, eventTypes: ['RoleGranted'], ...overrides })
        .expect(201)
    ).body as { id: string; destination: string };

  it('posts chosen events to the webhook', async () => {
    const { admin, name } = await createCompany();
    await createRule(admin, '/generic');

    await addMember(admin, 'viewer');

    await eventually(() => expect(viewerJoined('/generic')).toHaveLength(1));
    expect(viewerJoined('/generic')[0]!.body).toMatchObject({
      text: `${name}: Someone joined as Viewer.`,
      eventType: 'RoleGranted',
      companyName: name,
    });
  });

  it('uses Slack’s message format for Slack rules', async () => {
    const { admin, name } = await createCompany();
    await createRule(admin, '/slack', { kind: 'slack' });

    await addMember(admin, 'viewer');

    await eventually(() => expect(viewerJoined('/slack').map((item) => item.body)).toEqual([
      { text: `${name}: Someone joined as Viewer.` },
    ]));
  });

  it('skips events not chosen, and disabled rules', async () => {
    const { admin } = await createCompany();
    await createRule(admin, '/other-events', { eventTypes: ['CompanySuspended'] });
    const disabled = await createRule(admin, '/disabled');
    await admin.patch(`/api/v1/company/notification-rules/${disabled.id}`).send({ enabled: false }).expect(200);
    await createRule(admin, '/control');

    await addMember(admin, 'viewer');

    await eventually(() => expect(viewerJoined('/control')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(new Set(received.map((item) => item.path))).toEqual(new Set(['/control']));
  });

  it('keeps a failing webhook from affecting another, and records the failure', async () => {
    const { admin } = await createCompany();
    failingPaths.add('/broken');
    const broken = await createRule(admin, '/broken');
    await createRule(admin, '/healthy');

    await addMember(admin, 'viewer');

    await eventually(() => expect(viewerJoined('/healthy')).toHaveLength(1));
    await eventually(() => expect(received.filter((item) => item.path === '/broken').length).toBeGreaterThanOrEqual(2));
    const { body } = await admin.get('/api/v1/company/notification-rules').expect(200);
    const brokenRule = (body as { id: string; lastError: string | null }[]).find((rule) => rule.id === broken.id);
    expect(brokenRule?.lastError).toContain('status 500');
  });

  it('sends a test message on request', async () => {
    const { admin } = await createCompany();
    const rule = await createRule(admin, '/test');

    const { body } = await admin.post(`/api/v1/company/notification-rules/${rule.id}/test`).expect(200);

    expect(body).toEqual({ delivered: true, error: null });
    expect(received[0]!.body.text).toContain('This is a test message');
  });

  it('never shows the full address after saving it', async () => {
    const { admin } = await createCompany();
    const rule = await createRule(admin, '/secret-path-abc123');

    const { body } = await admin.get('/api/v1/company/notification-rules').expect(200);

    expect(rule.destination).toBe(receiverUrl);
    expect(JSON.stringify(body)).not.toContain('secret-path-abc123');
  });

  it("keeps companies' rules apart", async () => {
    const first = await createCompany();
    const second = await createCompany();
    const rule = await createRule(first.admin, '/first');

    const { body } = await second.admin.get('/api/v1/company/notification-rules').expect(200);

    expect(body).toEqual([]);
    await second.admin.delete(`/api/v1/company/notification-rules/${rule.id}`).expect(404);
  });

  it('is managed only with the notifications permission', async () => {
    const { admin } = await createCompany();
    const techLead = await addMember(admin, 'tech-lead');

    await techLead.agent.get('/api/v1/company/notification-rules').expect(403);
  });
});
