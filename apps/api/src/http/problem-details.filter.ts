import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { DomainError, type DomainErrorKind, MissingTenantContextError } from '@dreamdevops/shared-kernel';
import type { Response } from 'express';

const GENERIC_MESSAGES: Readonly<Record<number, string>> = {
  400: 'The request is not valid.',
  401: 'Sign in to continue.',
  403: 'You do not have permission to do this.',
  404: 'This resource does not exist.',
  409: 'This conflicts with the current state.',
  413: 'The request is too large.',
  429: 'Too many requests. Try again shortly.',
  500: 'Something went wrong on our side.',
  503: 'A service the platform depends on is unavailable. Try again shortly.',
};

/** The status each kind of refusal answers with, in every module. */
const DOMAIN_ERROR_STATUSES: Readonly<Record<DomainErrorKind, number>> = {
  invalid: 400,
  forbidden: 403,
  'not-entitled': 403,
  'not-found': 404,
  conflict: 409,
  unavailable: 503,
};

/** Answers every error in one format (RFC 9457), and never reveals internal details. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  readonly #logger = new Logger(ProblemDetailsFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, detail } = this.#describe(error);
    response
      .status(status)
      .type('application/problem+json')
      .send({ status, title: GENERIC_MESSAGES[status] ?? 'The request failed.', ...(detail && { detail }) });
  }

  #describe(error: unknown): { status: number; detail?: string } {
    if (error instanceof HttpException) {
      return { status: error.getStatus(), detail: error.message };
    }
    // Every module's refusals, whichever module they come from.
    if (error instanceof DomainError) {
      const kind: DomainErrorKind = error.kind;
      return { status: DOMAIN_ERROR_STATUSES[kind], detail: error.message };
    }
    // A route that needs a company was called by a user who doesn't act for one.
    if (error instanceof MissingTenantContextError) {
      return { status: 403 };
    }
    // Errors from Express middleware, such as an oversized or malformed body.
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return { status };
    }
    this.#logger.error(error);
    return { status: 500 };
  }
}
