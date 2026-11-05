import { defineApplicationType } from '../../domain/application-type.ts';
import { ANGULAR } from '../scaffolds/angular.ts';
import { REACT } from '../scaffolds/react.ts';
import { TYPESCRIPT } from '../languages/typescript.ts';
import { FRONTEND } from '../layers.ts';

export const TYPESCRIPT_FRONTEND = defineApplicationType({
  language: TYPESCRIPT,
  layer: FRONTEND,
  description: 'A web app that builds into static files, served as they are.',
  frameworks: ['Angular', 'React', 'Vue', 'Svelte'],
  scaffolds: [ANGULAR, REACT],
  serving: { kind: 'static', directory: 'dist' },
});
