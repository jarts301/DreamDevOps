import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import about from '../src/about.json' with { type: 'json' };
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';

describe('the API, without a database', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot({ port: 0, databaseUrl: null })],
    }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('says what it is', () => {
    return request(app.getHttpServer()).get('/').expect(200).expect(about);
  });

  it('is healthy', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', database: 'not configured' });
  });

  it('explains that notes need a database', async () => {
    const response = await request(app.getHttpServer())
      .get('/notes')
      .expect(503);

    expect(response.body.message).toContain('DATABASE_URL');
  });

  it.each([{}, { text: '' }, { text: 42 }, { text: 'ok', extra: true }])(
    'refuses the note %j before reaching the database',
    (body) => {
      return request(app.getHttpServer()).post('/notes').send(body).expect(400);
    },
  );
});
