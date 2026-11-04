import { fileURLToPath } from 'node:url';
import { Controller, Get, type INestApplication, Inject, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDomainEvent, currentCompanyId } from '@dreamdevops/shared-kernel';
import { appendToOutbox, migrateSharedKernel, TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/configure-app.ts';
import { migrateApi } from '../src/database/migrate.ts';
import { Authenticated } from '../src/http/access.decorators.ts';
import { PostgresSessionStore } from '../src/session/postgres-session-store.ts';
import { hashSessionId } from '../src/session/session-store.ts';
import { describeSessionStoreContract } from './session-store-contract.ts';
import { testConfig } from './test-app.ts';

const BOOTSTRAP_SQL = fileURLToPath(new URL('../../../infra/local/postgres/init-platform-database.sql', import.meta.url));

let container: StartedPostgreSqlContainer;
let appPool: pg.Pool;
let store: PostgresSessionStore;

const urlFor = (role: string) =>
  `postgres://dreamdevops_${role}:${role}@${container.getHost()}:${container.getPort()}/dreamdevops`;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17.11-alpine')
    .withCopyFilesToContainer([{ source: BOOTSTRAP_SQL, target: '/tmp/init-platform-database.sql' }])
    .start();
  const bootstrap = await container.exec(
    [
      'psql',
      '-U',
      container.getUsername(),
      '-d',
      'postgres',
      ...['owner', 'app', 'relay', 'jobs'].flatMap((role) => ['-v', `${role}_password=${role}`]),
      '-f',
      '/tmp/init-platform-database.sql',
    ],
  );
  if (bootstrap.exitCode !== 0) {
    throw new Error(`Database setup failed: ${bootstrap.output}`);
  }
  await migrateSharedKernel(urlFor('owner'));
  await migrateApi(urlFor('owner'));
  appPool = new pg.Pool({ connectionString: urlFor('app') });
  store = new PostgresSessionStore(appPool);
});

afterAll(async () => {
  await appPool.end();
  await container.stop();
});

describeSessionStoreContract('PostgreSQL', () => store);

describe('session storage', () => {
  it('gives the application role no direct access to sessions', async () => {
    await expect(appPool.query('SELECT * FROM api.sessions')).rejects.toThrow('permission denied');
    await expect(appPool.query('DELETE FROM api.sessions')).rejects.toThrow('permission denied');
  });

  it('removes expired sessions when a new one is created', async () => {
    const principal = { subject: 's', displayName: 'S', companyId: null, permissions: [] };
    await store.create('short-lived', principal, { absoluteMs: 1, idleMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await store.create('fresh', principal, { absoluteMs: 60_000, idleMs: 60_000 });

    const owner = new pg.Client({ connectionString: urlFor('owner') });
    await owner.connect();
    try {
      const { rows } = await owner.query("SELECT 1 FROM api.sessions WHERE id_hash = 'short-lived'");
      expect(rows).toEqual([]);
    } finally {
      await owner.end();
    }
  });

  it('applies migrations only once', async () => {
    await expect(migrateApi(urlFor('owner'))).resolves.toEqual([]);
  });
});

@Controller('sample')
class SampleController {
  readonly #database: TenantDatabase;

  constructor(@Inject(TenantDatabase) database: TenantDatabase) {
    this.#database = database;
  }

  @Authenticated()
  @Post('events')
  async save(): Promise<object> {
    const event = createDomainEvent({
      eventType: 'SampleCreated',
      companyId: currentCompanyId(),
      payload: {},
    });
    await this.#database.transaction((tx) => appendToOutbox(tx, [event]));
    return { eventId: event.eventId };
  }

  @Authenticated()
  @Get('events')
  async list(): Promise<object> {
    const eventIds = await this.#database.transaction(async (tx) => {
      const { rows } = await tx.query('SELECT event_id FROM kernel.outbox');
      return rows.map((row) => row.event_id as string);
    });
    return { eventIds };
  }
}

describe('from an HTTP request to company data', () => {
  let app: INestApplication;

  const signIn = async (user: string) => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent.get(`/api/v1/auth/login?as=${user}`).expect(302);
    const callback = new URL(login.headers.location as string);
    await agent.get(callback.pathname + callback.search).expect(302);
    return agent;
  };

  beforeAll(async () => {
    const config = testConfig({ databaseUrl: urlFor('app'), secureCookies: false });
    app = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot({ config, controllers: [SampleController] }),
      { bodyParser: false, logger: false },
    );
    configureApp(app as NestExpressApplication, config);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('signs in with a session stored in PostgreSQL', async () => {
    const agent = await signIn('developer-a');

    const { body } = await agent.get('/api/v1/auth/me').expect(200);
    expect(body.subject).toBe('fake|developer-a');

    await agent.post('/api/v1/auth/logout').expect(204);
    await agent.get('/api/v1/auth/me').expect(401);
  });

  it('stores only a hash of the session ID', async () => {
    const server = app.getHttpServer();
    const login = await request(server).get('/api/v1/auth/login?as=developer-a');
    const loginCookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const callback = new URL(login.headers.location as string);
    const finished = await request(server).get(callback.pathname + callback.search).set('Cookie', loginCookie);
    const sessionId = (finished.headers['set-cookie'] as unknown as string[])
      .find((cookie) => cookie.startsWith('dd_session='))!
      .split(';')[0]!
      .slice('dd_session='.length);

    const owner = new pg.Client({ connectionString: urlFor('owner') });
    await owner.connect();
    try {
      const raw = await owner.query('SELECT 1 FROM api.sessions WHERE id_hash = $1', [sessionId]);
      const hashed = await owner.query('SELECT 1 FROM api.sessions WHERE id_hash = $1', [hashSessionId(sessionId)]);
      expect(raw.rows).toEqual([]);
      expect(hashed.rows).toHaveLength(1);
    } finally {
      await owner.end();
    }
  });

  it('lets a company see only its own data, through row-level security', async () => {
    const companyA = await signIn('tech-lead-a');
    const companyB = await signIn('tech-lead-b');

    const saved = await companyA.post('/api/v1/sample/events').expect(201);

    const seenByA = await companyA.get('/api/v1/sample/events').expect(200);
    const seenByB = await companyB.get('/api/v1/sample/events').expect(200);
    expect(seenByA.body.eventIds).toContain(saved.body.eventId);
    expect(seenByB.body.eventIds).not.toContain(saved.body.eventId);
  });

  it('denies company data to a user with no company', async () => {
    const admin = await signIn('platform-admin');

    await admin.get('/api/v1/sample/events').expect(403);
  });

  it('reports ready when it can reach the database', async () => {
    await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200, { status: 'up' });
  });
});
