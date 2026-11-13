import Fastify, { type FastifyInstance } from 'fastify';

export interface AppOptions {
  readonly logger?: boolean;
}

/** Builds the service without starting it, so tests can call it directly. */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  // The platform checks these to decide whether to restart the service or send it traffic.
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => ({ status: 'ok' }));

  app.get<{ Querystring: { name?: string } }>(
    '/api/hello',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
          additionalProperties: false,
        },
      },
    },
    async (request) => ({ message: `Hello, ${request.query.name ?? 'world'}!` }),
  );

  return app;
}
