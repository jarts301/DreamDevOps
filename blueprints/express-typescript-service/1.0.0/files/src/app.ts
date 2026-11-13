import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import { currentTraceFields } from './logging.ts';
import { isHealthCheck } from './metrics.ts';

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

/** Builds the service without starting it, so tests can start it on a port of their own. */
export function buildApp(options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');

  // Each line carries the trace it was written in, so the platform shows lines and traces together.
  const logger = pino(
    { enabled: options.logger === true || options.logStream !== undefined, mixin: currentTraceFields },
    options.logStream ?? process.stdout,
  );
  app.use(
    pinoHttp({
      logger,
      // The platform checks health every few seconds. Those checks aren't logged, so the logs show real traffic.
      autoLogging: { ignore: (request) => isHealthCheck(request.url) },
      // Only what identifies a request, never its headers, which can hold credentials such as cookies.
      serializers: {
        req: (request: { id: unknown; method: string; url: string }) => ({ id: request.id, method: request.method, url: request.url }),
        res: (response: { statusCode: number }) => ({ statusCode: response.statusCode }),
      },
    }),
  );
  allowCrossOrigin(app, options.corsOrigins ?? []);

  // The platform checks these every few seconds to decide whether to restart the service or send it traffic.
  app.get('/health/live', (_request, response) => {
    response.json({ status: 'ok' });
  });
  app.get('/health/ready', (_request, response) => {
    response.json({ status: 'ok' });
  });

  // Answers without doing anything, to check the service can be reached, and logs that it was.
  app.get('/api/ping', (request, response) => {
    request.log.info('Ping received');
    response.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.get('/api/hello', (request, response) => {
    const name = request.query['name'] ?? 'world';
    if (typeof name !== 'string' || name.length < 1 || name.length > 100) {
      response.status(400).json({ error: 'name must be between 1 and 100 characters.' });
      return;
    }
    request.log.info({ greeted: name }, 'Greeting sent');
    response.json({ message: `Hello, ${name}!` });
  });

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found.' });
  });
  // Anything a route throws is logged with its request, and answered without its details.
  // Express knows an error handler by its four parameters, so next stays, unused.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    request.log.error({ err: error }, 'Request failed');
    response.status(500).json({ error: 'Something went wrong.' });
  });
  return app;
}

/**
 * Lets web pages at the given origins call the service from browsers, and send the trace
 * they started, so a request from a page and its work here are one trace.
 */
function allowCrossOrigin(app: Express, origins: readonly string[]): void {
  if (origins.length === 0) {
    return;
  }
  app.use((request, response, next) => {
    const origin = request.headers.origin;
    const allowed = origin !== undefined && origins.includes(origin);
    if (allowed) {
      response.setHeader('access-control-allow-origin', origin);
    }
    response.setHeader('vary', 'Origin');
    // Browsers ask first, before a request with a header such as traceparent.
    if (request.method === 'OPTIONS') {
      if (!allowed) {
        response.status(403).end();
        return;
      }
      response
        .setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE')
        .setHeader('access-control-allow-headers', CORS_HEADERS)
        .setHeader('access-control-max-age', '600')
        .status(204)
        .end();
      return;
    }
    next();
  });
}
