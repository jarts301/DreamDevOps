import { createApp } from 'vue';
import App from './App.vue';
import { DEFAULT_SETTINGS, loadSettings } from './runtime-config';
import './styles.css';

// The settings come first, so the app never calls its API at the wrong address.
loadSettings()
  .catch((error: unknown) => {
    console.error(error);
    return DEFAULT_SETTINGS;
  })
  .then((settings) => {
    createApp(App, { settings }).mount('#app');
  });
