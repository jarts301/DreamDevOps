import { mount } from 'svelte';
import App from './App.svelte';
import { DEFAULT_SETTINGS, loadSettings } from './runtime-config';
import './styles.css';

// The settings come first, so the app never calls its API at the wrong address.
loadSettings()
  .catch((error: unknown) => {
    console.error(error);
    return DEFAULT_SETTINGS;
  })
  .then((settings) => {
    mount(App, { target: document.getElementById('app')!, props: { settings } });
  });
