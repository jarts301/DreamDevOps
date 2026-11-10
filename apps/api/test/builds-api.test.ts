import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { webhookSecret } from '../src/builds/domain/webhook-signature.ts';
import { createTestApp } from './test-app.ts';
import { signIn } from './support/integration.ts';

const APPLICATION = '00000000-0000-4000-8000-0000000000aa';


describe('build routes', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Sign-in cookies are Secure by default, and tests speak plain HTTP.
    app = await createTestApp({ config: { secureCookies: false } });
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['get', `/api/v1/company/applications/${APPLICATION}/builds`],
    ['get', `/api/v1/company/applications/${APPLICATION}/versions`],
    ['get', '/api/v1/company/image-signing-key'],
    ['post', `/api/v1/company/applications/${APPLICATION}/releases`],
    ['post', `/api/v1/company/applications/${APPLICATION}/pull-requests/1/builds`],
  ] as const)('ask anonymous users to sign in: %s %s', async (method, path) => {
    await request(app.getHttpServer())[method](path).expect(401);
  });

  it('let only people who may build feature images ask for one', async () => {
    // This sample member has neither feature-images:build nor releases:start.
    const member = await signIn(app, 'developer-a');

    await member.post(`/api/v1/company/applications/${APPLICATION}/pull-requests/1/builds`).expect(403);
    await member.post(`/api/v1/company/applications/${APPLICATION}/releases`).send({ bump: 'minor' }).expect(403);
    await member.post(`/api/v1/company/applications/${APPLICATION}/hotfixes`).expect(403);
    await member.post(`/api/v1/company/applications/${APPLICATION}/candidates`).send({ branch: 'release/1.0.0' }).expect(403);
  });

  it('publish the public key to every member', async () => {
    const member = await signIn(app, 'developer-a');

    const { body } = await member.get('/api/v1/company/image-signing-key').expect(200);

    expect(body.algorithm).toBe('ECDSA P-256 with SHA-256');
    expect(body.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(body.publicKey).not.toContain('PRIVATE');
  });
});

describe('the Forgejo webhook', () => {
  let app: INestApplication;
  const payload = JSON.stringify({ ref: 'release/1.0.0', ref_type: 'branch', sha: 'a'.repeat(40), repository: { full_name: 'acme/billing' } });
  const sign = (body: string, secret = webhookSecret('fake-dummy-webhook-secret', 'acme', 'billing')) =>
    createHmac('sha256', secret).update(body).digest('hex');
  const deliver = (body: string, signature: string | undefined) => {
    const call = request(app.getHttpServer())
      .post('/api/v1/hooks/forgejo')
      .set('Content-Type', 'application/json')
      .set('X-Forgejo-Event', 'create');
    return (signature === undefined ? call : call.set('X-Forgejo-Signature', signature)).send(body);
  };

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses deliveries without a valid signature', async () => {
    await deliver(payload, undefined).expect(401);
    await deliver(payload, sign(payload, 'a guess')).expect(401);
    // A signature over different bytes, even the same JSON, doesn't count.
    await deliver(`${payload} `, sign(payload)).expect(401);
    await deliver('{"repository":{"full_name":"../etc"}}', sign('{"repository":{"full_name":"../etc"}}')).expect(401);
  });

  it('accepts a signed delivery, and ignores one for a company it does not know', async () => {
    await deliver(payload, sign(payload)).expect(204);
  });

  it('is limited in size like every other route', async () => {
    const huge = JSON.stringify({ padding: 'x'.repeat(1_100_000) });
    await deliver(huge, sign(huge)).expect(413);
  });

  it('needs no session and is not blocked as a cross-site request', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/hooks/forgejo')
      .set('Content-Type', 'application/json')
      .set('X-Forgejo-Signature', sign(payload))
      .send(payload)
      .expect(204);
  });
});
