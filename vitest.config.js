import { defineConfig } from 'vitest/config';

// Standalone test config (does NOT load the app's vite.config.js, so the
// Tailwind/Vue build plugins don't run during unit tests). happy-dom gives us a
// `window` so the extension bridge (postMessage + structuredClone) is exercised
// exactly as it is inside a VS Code webview.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.js'],
    setupFiles: ['test/setup.js'],
  },
});
