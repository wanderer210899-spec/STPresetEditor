import { execSync } from 'node:child_process';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// Build of the SAME Vue SPA, packaged for the Cursor/VSCode extension webview.
// The only differences from vite.config.js:
//   • base: './'        → emit RELATIVE asset URLs (a webview has no server
//                         origin; the extension rewrites these to webview URIs).
//   • build.outDir      → drop the bundle into extension/media/, which the
//                         extension reads at runtime (gitignored build output).
// Run with: npm run build:webview
let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  // git not available — leave as "unknown"
}
const buildTime = new Date().toISOString();

export default defineConfig({
  base: './',
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(commit),
    'import.meta.env.VITE_BUILD_TIME': JSON.stringify(buildTime),
  },
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: 'extension/media',
    emptyOutDir: true,
  },
});
