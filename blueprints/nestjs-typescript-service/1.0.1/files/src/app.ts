import 'reflect-metadata';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { type Logger, pino } from 'pino';
import { pinoHttp } from 'pino-http';
import { AppModule } from './app.module.ts';
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

/**
 * Builds the service without starting it, so tests can start it on a port of their own.
 * Everything it logs, Nest's own messages included, is JSON.
 */
export async function buildApp(options: AppOptions = {}): Promise<INestApplication> {
  // Each line carries the trace it was written in, so the platform shows lines and traces together.
  const logger = pino(
    { enabled: options.logger === true || options.logStream !== undefined, mixin: currentTraceFields },
    options.logStream ?? process.stdout,
  );
  const app = await NestFactory.create(AppModule, { logger: new NestLogs(logger) });
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
  return app;
}

/**
 * Lets web pages at the given origins call the service from browsers, and send the trace
 * they started, so a request from a page and its work here are one trace.
 */
function allowCrossOrigin(app: INestApplication, origins: readonly string[]): void {
  if (origins.length === 0) {
    return;
  }
  app.use((request: Request, response: Response, next: NextFunction) => {
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

/**
 * Nest's own messages, such as about starting up, as JSON lines. Its routine ones are
 * debug lines, which aren't written unless asked for, so the logs show the service's work.
 */
class NestLogs implements LoggerService {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  log(message: unknown, context?: string): void {
    this.#logger.debug({ context }, String(message));
  }

  warn(message: unknown, context?: string): void {
    this.#logger.warn({ context }, String(message));
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.#logger.error({ context, stack: trace }, String(message));
  }

  fatal(message: unknown, context?: string): void {
    this.#logger.fatal({ context }, String(message));
  }

  debug(message: unknown, context?: string): void {
    this.#logger.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string): void {
    this.#logger.trace({ context }, String(message));
  }
}
