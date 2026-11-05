import type { Language } from '../../domain/application-type.ts';

/** npm scripts are the conventions: lint, test, build, start and migrate. */
export const TYPESCRIPT: Language = {
  key: 'typescript',
  name: 'TypeScript',
  runtime: { name: 'Node.js', version: '24', image: 'node:24-alpine' },
  commands: {
    install: 'npm ci',
    lint: 'npm run lint',
    test: 'npm test',
    build: 'npm run build',
    start: 'npm start',
    migrate: 'npm run migrate',
  },
  defaultPort: 3000,
};
