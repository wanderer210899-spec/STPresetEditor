// Local-file sync provider for the Cursor/VSCode extension (the "host").
//
// This is the file-backed sibling of cloudSync.js. Where cloudSync mirrors the
// store to a Cloudflare worker over HTTP, this mirrors the *currently open
// preset* to a local file via the webview <-> extension-host postMessage bridge.
//
// Data seam: a whole preset file in / out, so it uses parseFromJson (load) and
// the finalJson getter (save) — NOT buildSyncSnapshot/applyCloudData, which are
// the whole-library shape specific to cloud sync.
//
// Message protocol (this file <-> extension/extension.js):
//   webview -> host : { type: 'ready' }                 ask for the file to edit
//   host -> webview : { type: 'load', path, name, json } here is the file
//   webview -> host : { type: 'save', path, json }       write this back to disk
import { debounce } from 'lodash-es';
import { usePresetStore } from './presetStore';

// Coalesce rapid edits (typing, dragging) into one write.
const SAVE_DEBOUNCE_MS = 800;

// The VSCode webview API handle (acquireVsCodeApi may be called only once).
let vscodeApi = null;
// Ensures the store subscription is attached only once.
let subscribed = false;
// Absolute path of the file currently being edited (target for saves).
let activePath = null;
// finalJson we last mirrored to disk; used to skip echo writes and no-op saves.
let lastSyncedJson = null;

/** True when running inside a Cursor/VSCode webview (host mode). */
export function isVsCodeHost() {
  return typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function';
}

function getApi() {
  if (!vscodeApi && isVsCodeHost()) {
    vscodeApi = window.acquireVsCodeApi();
  }
  return vscodeApi;
}

function post(message) {
  const api = getApi();
  if (api) api.postMessage(message);
}

/**
 * Apply a preset file pushed from the host into the store.
 * Marks the result as already-synced so the $subscribe it triggers does not
 * immediately echo a save back to the host.
 */
function applyLoad(store, message) {
  if (typeof message.json !== 'string') return;
  if (message.path) activePath = message.path;
  store.parseFromJson(message.json); // also runs analyzeAllMacros()
  if (message.name) store.originalFilename = message.name;
  lastSyncedJson = store.finalJson;
}

/** Push the current preset to the host (skips no-op / echo writes). */
function saveNow(store) {
  if (!activePath) return;
  const json = store.finalJson;
  if (json === lastSyncedJson) return; // nothing meaningful changed
  lastSyncedJson = json;
  post({ type: 'save', path: activePath, json });
}

/**
 * Initialise the local-file bridge: listen for the file from the host, then
 * write back (debounced) on every change. Safe no-op outside a webview.
 */
export async function initLocalBridge() {
  if (!isVsCodeHost()) return;
  const store = usePresetStore();

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'load') applyLoad(store, message);
  });

  if (!subscribed) {
    subscribed = true;
    const debouncedSave = debounce(() => saveNow(store), SAVE_DEBOUNCE_MS);
    store.$subscribe(() => debouncedSave());
  }

  // Tell the host we're listening; it replies with a 'load' message.
  post({ type: 'ready' });
}
