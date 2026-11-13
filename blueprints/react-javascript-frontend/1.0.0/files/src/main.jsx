import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { DEFAULT_SETTINGS, loadSettings } from './runtime-config.js';
import './styles.css';

// The settings come first, so the app never calls its API at the wrong address.
loadSettings()
  .catch((/** @type {unknown} */ error) => {
    console.error(error);
    return DEFAULT_SETTINGS;
  })
  .then((settings) => {
    createRoot(/** @type {HTMLElement} */ (document.getElementById('root'))).render(
      <StrictMode>
        <App settings={settings} />
      </StrictMode>,
    );
  });
