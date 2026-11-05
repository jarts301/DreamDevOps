import type { Layer } from '../domain/application-type.ts';

// To add a layer, such as workers or mobile apps, add it here and define its types.
export const FRONTEND: Layer = {
  key: 'frontend',
  name: 'Frontend',
  description: 'What people use in their browser.',
  order: 1,
  migrations: false,
};

export const BACKEND: Layer = {
  key: 'backend',
  name: 'Backend',
  description: 'Services and APIs that frontends and other software call.',
  order: 2,
  migrations: true,
};
