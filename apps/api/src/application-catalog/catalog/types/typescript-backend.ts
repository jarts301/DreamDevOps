import { defineApplicationType } from '../../domain/application-type.ts';
import { NESTJS } from '../scaffolds/nestjs.ts';
import { TYPESCRIPT } from '../languages/typescript.ts';
import { BACKEND } from '../layers.ts';

export const TYPESCRIPT_BACKEND = defineApplicationType({
  language: TYPESCRIPT,
  layer: BACKEND,
  description: 'A Node.js service or API that may own a database.',
  frameworks: ['NestJS', 'Express', 'Fastify'],
  scaffolds: [NESTJS],
  serving: { kind: 'process', healthCheckPath: '/health' },
});
