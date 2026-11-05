import { TenancyError } from '../domain/errors.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TenancyError('invalid', 'The ID is not valid.');
  }
  return value.toLowerCase();
}

/** Whether PostgreSQL refused a duplicate for this unique constraint. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const { code, constraint: violated } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  return code === '23505' && violated === constraint;
}

/** Request bodies arrive unchecked, so anything that isn't an object counts as empty. */
export function fieldsOf(body: unknown): Readonly<Record<string, unknown>> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
