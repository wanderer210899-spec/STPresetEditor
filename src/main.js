import FloatingVue from 'floating-vue';
import 'floating-vue/dist/style.css';
import { createPinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';
import { createApp } from 'vue';
import App from './App.vue';
import exampleData from './assets/example.json';
import { initCloudSync } from './stores/cloudSync';
import { initLocalBridge, isVsCodeHost } from './stores/localBridge';
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

  // Inside the Cursor/VSCode extension the preset comes from a local file via
  // the host bridge — not the cloud, and not the bundled example. The host
  // pushes the file content as a 'load' message right after we signal 'ready'.
  // (Cloud sync alongside files is M2c — see EXTENSION_PLAN.md.)
  if (isVsCodeHost()) {
    await initLocalBridge();
    return;
  }

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
