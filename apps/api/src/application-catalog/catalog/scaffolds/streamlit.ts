import { defineScaffold } from '../../domain/scaffold.ts';

export const STREAMLIT = defineScaffold({
  key: 'streamlit',
  name: 'Streamlit',
  description: 'A Streamlit app, for dashboards and data apps.',
  includes: [
    'A Streamlit page that runs on the type’s port',
    'pytest with Streamlit’s AppTest for page tests',
    'Ruff for linting and formatting',
    'uv for dependencies, with a lockfile',
  ],
});
