import { defineApplicationType } from '../../domain/application-type.ts';
import { STREAMLIT } from '../scaffolds/streamlit.ts';
import { PYTHON } from '../languages/python.ts';
import { FRONTEND } from '../layers.ts';

export const PYTHON_FRONTEND = defineApplicationType({
  language: PYTHON,
  layer: FRONTEND,
  description: 'A web app whose pages a Python process renders, such as a dashboard or data app.',
  frameworks: ['Streamlit', 'Reflex', 'NiceGUI'],
  scaffolds: [STREAMLIT],
  serving: { kind: 'process', healthCheckPath: '/' },
});
