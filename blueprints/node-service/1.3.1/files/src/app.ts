import Fastify, { type FastifyInstance } from 'fastify';
import { currentTraceFields } from './logging.ts';

export interface AppOptions {
  /** Logs each request, and what the routes say, as JSON lines on standard output. */
  readonly logger?: boolean;
  /** Where log lines go instead of standard output. Tests read them. */
  readonly logStream?: { write(line: string): void };
  /** Web pages at these origins may call the service from browsers. None by default. */
  readonly corsOrigins?: readonly string[];
}

/** Headers browsers may send across origins, including the trace a page started. */
const CORS_HEADERS = 'content-type, authorization, traceparent, tracestate';

/** Builds the service without starting it, so tests can call it directly. */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const logging = options.logger === true || options.logStream !== undefined;
  const app = Fastify({
    // Each line carries the trace it was written in, so the platform shows lines and traces together.
    logger: logging ? { mixin: currentTraceFields, ...(options.logStream && { stream: options.logStream }) } : false,
  });

  allowCrossOrigin(app, options.corsOrigins ?? []);

  // The platform checks these every few seconds to decide whether to restart the service or
  // send it traffic. They aren't logged, so the logs show real traffic.
  app.get('/health/live', { logLevel: 'silent' }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { logLevel: 'silent' }, async () => ({ status: 'ok' }));

  // Answers without doing anything, to check the service can be reached, and logs that it was.
  app.get('/api/ping', async (request) => {
    request.log.info('Ping received');
    return { status: 'ok', time: new Date().toISOString() };
  });

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
    async (request) => {
      const name = request.query.name ?? 'world';
      request.log.info({ greeted: name }, 'Greeting sent');
      return { message: `Hello, ${name}!` };
    },
  );

  return app;
}

/**
 * Lets web pages at the given origins call the service from browsers, and send the trace
 * they started, so a request from a page and its work here are one trace.
 */
function allowCrossOrigin(app: FastifyInstance, origins: readonly string[]): void {
  if (origins.length === 0) {
    return;
  }
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin !== undefined && origins.includes(origin)) {
      reply.header('access-control-allow-origin', origin);
    }
    reply.header('vary', 'Origin');
  });
  // Browsers ask first, before a request with a header such as traceparent.
  app.options('/*', { logLevel: 'silent' }, async (request, reply) => {
    if (!reply.hasHeader('access-control-allow-origin')) {
      return reply.code(403).send();
    }
    return reply
      .header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE')
      .header('access-control-allow-headers', CORS_HEADERS)
      .header('access-control-max-age', '600')
      .code(204)
      .send();
  });
}
