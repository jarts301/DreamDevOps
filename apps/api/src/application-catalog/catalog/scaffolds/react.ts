import { defineScaffold } from '../../domain/scaffold.ts';

export const REACT = defineScaffold({
  key: 'react',
  name: 'React',
  description: 'A React app built with Vite.',
  includes: [
    'React with Vite for development and builds',
    'Vitest and Testing Library for component tests',
    'ESLint with typescript-eslint and the React Hooks rules',
    'Prettier',
    'A production build into dist/',
  ],
});
