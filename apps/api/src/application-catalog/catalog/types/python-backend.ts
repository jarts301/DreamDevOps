import { defineApplicationType } from '../../domain/application-type.ts';
import { FASTAPI } from '../scaffolds/fastapi.ts';
import { PYTHON } from '../languages/python.ts';
import { BACKEND } from '../layers.ts';

export const PYTHON_BACKEND = defineApplicationType({
  language: PYTHON,
  layer: BACKEND,
  description: 'A Python service or API that may own a database.',
  frameworks: ['FastAPI', 'Django', 'Flask'],
  scaffolds: [FASTAPI],
  serving: { kind: 'process', healthCheckPath: '/health' },
});
