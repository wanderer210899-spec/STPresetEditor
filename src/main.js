import FloatingVue from 'floating-vue';
import 'floating-vue/dist/style.css';
import { createPinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';
import { createApp } from 'vue';
import App from './App.vue';
import exampleData from './assets/example.json';
import { initCloudSync } from './stores/cloudSync';
import { initLocalBridge } from './stores/localBridge';
import { getEditorMode } from './utils/host';
import { usePresetStore } from './stores/presetStore';
import './style.css';

// Create Vue application instance
const app = createApp(App);

// Create Pinia store instance for state management
const pinia = createPinia();

// Add persistence plugin to Pinia for localStorage integration
pinia.use(piniaPluginPersistedstate);

// Register plugins with the Vue app
app.use(pinia); // State management
app.use(FloatingVue); // Tooltip and popover functionality

// Mount the application to the DOM
app.mount('#app');

// Bootstrap order matters for a seamless multi-device experience:
//   1. Restore from the local cache (already done by the persist plugin).
//   2. Reconcile with the cloud — adopt the user's library if signed in.
//   3. Only if there is still nothing to show, load the bundled example.
// This prevents briefly flashing the example over a real cloud library.
async function bootstrap() {
  const store = usePresetStore();

  // Apply the persisted theme immediately (before any cloud round-trip) and
  // keep it live (OS scheme changes / VS Code theme switches).
  store.initTheme();

  const mode = getEditorMode();

  // File-backed extension webview (Interface A): the OPEN preset comes from a
  // local file via the host bridge — never the cloud, never the example. Edits
  // stay local (mirrored to disk); the only cloud affordance is the explicit
  // "Send to cloud" button, which needs no engine here.
  if (mode === 'file') {
    await initLocalBridge();
    return;
  }

  // Cloud browser webview (Interface B): no file attached. It opens BLANK —
  // the cloud library is a list you load from, so mirror the cloud list and
  // open the Preset Manager instead of auto-loading anything.
  if (mode === 'library') {
    await initLocalBridge();
    try {
      await initCloudSync();
    } catch (error) {
      console.error('[cloudSync] initialization failed:', error);
    }
    if (!store.rawJson) store.openPresetManager();
    return;
  }

  // Web SPA.
  try {
    await initCloudSync();
  } catch (error) {
    console.error('[cloudSync] initialization failed:', error);
  }
  if (!store.rawJson) {
    store.initializeDefaultData(JSON.stringify(exampleData));
  }
}
bootstrap();
