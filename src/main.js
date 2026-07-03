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

  // File-backed extension webview: the OPEN preset comes from a local file via
  // the host bridge — not the cloud, and not the bundled example. The host
  // pushes the file content as a 'load' message right after we signal 'ready'.
  // The saved-preset LIBRARY still syncs through the same cloud engine below
  // (host transport), so the example must never load over a real cloud library.
  if (mode === 'file') {
    await initLocalBridge();
    try {
      await initCloudSync();
    } catch (error) {
      console.error('[cloudSync] initialization failed:', error);
    }
    return;
  }

  // Standalone extension editor: no file attached. It behaves like the web app
  // (edit a library preset, autosaved + synced), but cloud rides the host
  // bridge. initLocalBridge wires the host message listener the cloud transport
  // needs; there is no open file, so its file-save path stays idle.
  if (mode === 'library') {
    await initLocalBridge();
    try {
      await initCloudSync();
    } catch (error) {
      console.error('[cloudSync] initialization failed:', error);
    }
    if (!store.rawJson) {
      // Restore the last-edited (or default) library preset into the active
      // area; fall back to the bundled example for a brand-new instance.
      const restoreId =
        (store.currentPresetId &&
          store.savedPresets[store.currentPresetId] &&
          store.currentPresetId) ||
        (store.defaultPresetId &&
          store.savedPresets[store.defaultPresetId] &&
          store.defaultPresetId);
      if (restoreId) store.loadPreset(restoreId);
      else store.initializeDefaultData(JSON.stringify(exampleData));
    }
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
