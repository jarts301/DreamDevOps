import type { ApplicationType } from '../domain/application-type.ts';
import { PYTHON_BACKEND } from './types/python-backend.ts';
import { PYTHON_FRONTEND } from './types/python-frontend.ts';
import { TYPESCRIPT_BACKEND } from './types/typescript-backend.ts';
import { TYPESCRIPT_FRONTEND } from './types/typescript-frontend.ts';

/**
 * Every type companies can register applications as. To add one, define it in types/
 * and list it here. The API checks each at startup, and the tests check each too.
 */
export const APPLICATION_TYPE_CATALOG: readonly ApplicationType[] = [
  TYPESCRIPT_FRONTEND,
  TYPESCRIPT_BACKEND,
  PYTHON_FRONTEND,
  PYTHON_BACKEND,
];
