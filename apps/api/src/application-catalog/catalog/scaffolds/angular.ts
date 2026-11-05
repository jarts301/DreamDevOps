import { defineScaffold } from '../../domain/scaffold.ts';

export const ANGULAR = defineScaffold({
  key: 'angular',
  name: 'Angular',
  description: 'An Angular app with standalone components, signals and routing.',
  includes: [
    'Standalone components, signals and the router',
    'Vitest and jsdom for component tests',
    'ESLint with angular-eslint, including accessibility rules',
    'Prettier',
    'A production build into dist/',
  ],
});
