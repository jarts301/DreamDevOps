import type { INestApplication } from '@nestjs/common';
import { InMemoryJobQueue } from '@dreamdevops/shared-kernel/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_QUEUE, OUTBOX_RELAY } from '../src/background/background-work.ts';
import { PROVISIONING_TRIGGERS } from '../src/tenancy/application/provisioning.service.ts';
import { REPOSITORY_TRIGGERS } from '../src/tenancy/application/repositories.service.ts';
import { createTestApp, FakeRelay } from './test-app.ts';

const COMPANY = '4707316c-b477-41ae-b8eb-0ddd1ef86f79';
const APPLICATION = '99999999-b477-41ae-b8eb-0ddd1ef86f79';

const PLATFORM_ROUTES = [
  ['get', '/api/v1/platform/companies'],
  ['post', '/api/v1/platform/companies'],
  ['get', `/api/v1/platform/companies/${COMPANY}`],
  ['patch', `/api/v1/platform/companies/${COMPANY}`],
  ['post', `/api/v1/platform/companies/${COMPANY}/suspend`],
  ['post', `/api/v1/platform/companies/${COMPANY}/reactivate`],
  ['post', `/api/v1/platform/companies/${COMPANY}/close`],
  ['post', `/api/v1/platform/companies/${COMPANY}/erase`],
  ['post', `/api/v1/platform/companies/${COMPANY}/provisioning`],
] as const;

const COMPANY_ROUTES = [
  ['get', '/api/v1/company'],
  ['get', '/api/v1/company/applications'],
  ['post', '/api/v1/company/applications'],
  ['get', `/api/v1/company/applications/${APPLICATION}`],
  ['patch', `/api/v1/company/applications/${APPLICATION}`],
  ['post', `/api/v1/company/applications/${APPLICATION}/archive`],
  ['post', `/api/v1/company/applications/${APPLICATION}/restore`],
  ['post', `/api/v1/company/applications/${APPLICATION}/repository`],
] as const;

describe('tenancy routes', () => {
  let app: INestApplication;

  const signIn = async (user: string) => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent.get(`/api/v1/auth/login?login_hint=${user}`).expect(302);
    const callback = new URL(login.headers.location as string);
    await agent.get(callback.pathname + callback.search).expect(302);
    return agent;
  };

  beforeAll(async () => {
    app = await createTestApp({ config: { secureCookies: false } });
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([...PLATFORM_ROUTES, ...COMPANY_ROUTES])('asks anonymous users to sign in for %s %s', async (method, path) => {
    await request(app.getHttpServer())[method](path).expect(401);
  });

  // The sample users in the fakes belong to companies, but none is a Platform Admin.
  it.each(PLATFORM_ROUTES)('keeps %s %s for Platform Admins', async (method, path) => {
    const techLead = await signIn('tech-lead-a');

    await techLead[method](path).send({}).expect(403);
  });

  // The sample users have none of the real company permissions, and a Platform Admin
  // has no company, so all of them are refused before any company data is read.
  it.each(COMPANY_ROUTES)('keeps %s %s for company members with the permission', async (method, path) => {
    const platformAdmin = await signIn('platform-admin');
    const developer = await signIn('developer-a');

    await platformAdmin[method](path).send({}).expect(403);
    await developer[method](path).send({}).expect(403);
  });
});

describe('background work', () => {
  it('subscribes provisioning before the relay starts, and stops the relay at shutdown', async () => {
    const queue = new InMemoryJobQueue();
    const relay = new FakeRelay();
    const app = await createTestApp({
      overrides: [
        { provide: JOB_QUEUE, useValue: queue },
        { provide: OUTBOX_RELAY, useValue: relay },
      ],
    });

    expect(relay.started).toBe(true);
    for (const eventType of PROVISIONING_TRIGGERS) {
      // Sending fails for a queue nobody created, so this proves each subscription exists.
      await expect(queue.send(`events.tenancy-provisioning.${eventType}`, {})).resolves.not.toBeNull();
    }
    for (const eventType of REPOSITORY_TRIGGERS) {
      await expect(queue.send(`events.tenancy-repositories.${eventType}`, {})).resolves.not.toBeNull();
    }

    await app.close();
    expect(relay.stopped).toBe(true);
  });
});
