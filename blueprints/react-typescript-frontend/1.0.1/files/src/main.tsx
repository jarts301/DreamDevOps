import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DEFAULT_SETTINGS, loadSettings } from './runtime-config';
import './styles.css';

// The settings come first, so the app never calls its API at the wrong address.
loadSettings()
  .catch((error: unknown) => {
    console.error(error);
    return DEFAULT_SETTINGS;
  })
  .then((settings) => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App settings={settings} />
      </StrictMode>,
    );
  });
