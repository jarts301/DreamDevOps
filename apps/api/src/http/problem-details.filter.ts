import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { MissingTenantContextError } from '@dreamdevops/shared-kernel';
import type { Response } from 'express';
import { BuildError } from '../builds/domain/errors.ts';
import { ReleaseError } from '../releases/domain/errors.ts';
import { CatalogError } from '../catalog/domain/errors.ts';
import { EditionError } from '../editions/domain/errors.ts';
import { AccessError } from '../identity-access/domain/errors.ts';
import { NotificationError } from '../notifications/domain/errors.ts';
import { TenancyError } from '../tenancy/domain/errors.ts';

const GENERIC_MESSAGES: Readonly<Record<number, string>> = {
  400: 'The request is not valid.',
  401: 'Sign in to continue.',
  403: 'You do not have permission to do this.',
  404: 'This resource does not exist.',
  409: 'This conflicts with the current state.',
  413: 'The request is too large.',
  429: 'Too many requests. Try again shortly.',
  500: 'Something went wrong on our side.',
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
    if (
      error instanceof AccessError ||
      error instanceof TenancyError ||
      error instanceof NotificationError ||
      error instanceof CatalogError ||
      error instanceof ReleaseError
    ) {
      const statuses = { invalid: 400, 'not-found': 404, conflict: 409 };
      return { status: statuses[error.kind], detail: error.message };
    }
    if (error instanceof BuildError) {
      const statuses = { invalid: 400, unauthorized: 401, 'not-found': 404, conflict: 409, 'too-large': 413 };
      return { status: statuses[error.kind], detail: error.message };
    }
    if (error instanceof EditionError) {
      const statuses = { invalid: 400, 'not-found': 404, conflict: 409, 'not-entitled': 403 };
      return { status: statuses[error.kind], detail: error.message };
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
