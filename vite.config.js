import { execSync } from 'node:child_process';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// Stamp the build with the current commit so a running instance can prove
// exactly which version is deployed (shown in Settings). Helps catch the case
// where an older build is still live.
let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  // git not available (e.g. tarball build) — leave as "unknown"
}
const buildTime = new Date().toISOString();

// https://vite.dev/config/
export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(commit),
    'import.meta.env.VITE_BUILD_TIME': JSON.stringify(buildTime),
  },
  plugins: [vue(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    open: true,
  },
});
