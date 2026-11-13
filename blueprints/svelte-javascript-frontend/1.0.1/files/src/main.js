import { mount } from 'svelte';
import App from './App.svelte';
import { DEFAULT_SETTINGS, loadSettings } from './runtime-config.js';
import './styles.css';

// The settings come first, so the app never calls its API at the wrong address.
loadSettings()
  .catch((/** @type {unknown} */ error) => {
    console.error(error);
    return DEFAULT_SETTINGS;
  })
  .then((settings) => {
    mount(App, { target: /** @type {HTMLElement} */ (document.getElementById('app')), props: { settings } });
  });
