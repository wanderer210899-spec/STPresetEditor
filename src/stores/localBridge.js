// Local-file + cloud bridge for the Cursor/VSCode extension (the "host").
//
// File side: the file-backed sibling of cloudSync.js — mirrors the open preset
// to a local file via the webview <-> host postMessage bridge (parseFromJson in,
// finalJson out).
//
// Cloud side (M2c): the HOST does the Cloudflare HTTP (Node, no CORS). Here we
// just hand it the current preset to PUSH on edit, and apply what it PULLS. Two
// independent baselines keep the two mirrors from echoing into each other:
//   • fileSyncedJson  — finalJson last written to disk
//   • cloudSyncedJson — current-preset payload last pushed to the cloud
//
// Protocol (this file <-> extension/extension.js):
//   webview -> host : ready | save{path,json} | cloudConfig{key} | cloudPush{data}
//   host -> webview : load{path,name,json} | cloudPulled{data} | cloudAck{ok,updatedAt}
import { debounce } from 'lodash-es';
import { usePresetStore } from './presetStore';
import { useSyncStore } from './syncStore';

const SAVE_DEBOUNCE_MS = 800;

let vscodeApi = null;
let subscribed = false;
let activePath = null;
let fileSyncedJson = null;
let cloudSyncedJson = null;
let store = null;
let sync = null;

/** True when running inside a Cursor/VSCode webview (host mode). */
export function isVsCodeHost() {
  return typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function';
}

function getApi() {
  if (!vscodeApi && isVsCodeHost()) vscodeApi = window.acquireVsCodeApi();
  return vscodeApi;
}

function post(message) {
  const api = getApi();
  if (api) api.postMessage(message);
}

function cloudEnabled() {
  return Boolean(sync.syncKey);
}

/**
 * The current preset in the same shape the cloud document uses for these keys
 * (a subset of SYNC_DATA_PATHS), so the mobile/web app adopts it via
 * applyCloudData unchanged — and the host's merge leaves everything else alone.
 */
function currentPresetPayload() {
  return {
    rawJson: store.rawJson,
    prompts: store.prompts,
    promptOrder: store.promptOrder,
    originalFilename: store.originalFilename,
  };
}

/** Apply a preset file pushed from the host. Opening neither rewrites the file
 *  nor pushes to the cloud (both baselines are set to the just-loaded state). */
function applyLoad(message) {
  if (typeof message.json !== 'string') return;
  if (message.path) activePath = message.path;
  store.parseFromJson(message.json); // also runs analyzeAllMacros()
  if (message.name) store.originalFilename = message.name;
  fileSyncedJson = store.finalJson;
  cloudSyncedJson = JSON.stringify(currentPresetPayload());
}

/** Apply a preset PULLED from the cloud: mark it cloud-synced (don't echo it
 *  back) but leave the file baseline stale so it gets written to the open file. */
function applyCloudPull(data) {
  if (!data || typeof data.rawJson !== 'string') {
    sync.set({ status: 'synced' });
    return;
  }
  store.parseFromJson(data.rawJson);
  cloudSyncedJson = JSON.stringify(currentPresetPayload());
  sync.set({ status: 'synced', lastSyncedAt: new Date().toISOString() });
}

/** Debounced mirror to both targets; each guarded so unchanged content is a no-op. */
function saveNow() {
  if (activePath) {
    const json = store.finalJson;
    if (json !== fileSyncedJson) {
      fileSyncedJson = json;
      post({ type: 'save', path: activePath, json });
    }
  }
  if (cloudEnabled()) {
    const serialized = JSON.stringify(currentPresetPayload());
    if (serialized !== cloudSyncedJson) {
      cloudSyncedJson = serialized;
      sync.set({ status: 'syncing' });
      // Post a plain clone (not the Vue reactive proxy) for a safe structured clone.
      post({ type: 'cloudPush', data: JSON.parse(serialized) });
    }
  }
}

function sendCloudConfig() {
  post({ type: 'cloudConfig', key: sync.syncKey || '' });
}

/**
 * Initialise the host bridge: receive the file, then mirror edits to the file
 * and (if a passphrase is set) to the cloud. Safe no-op outside a webview.
 */
export async function initLocalBridge() {
  if (!isVsCodeHost()) return;
  store = usePresetStore();
  sync = useSyncStore();

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'load':
        applyLoad(message);
        break;
      case 'cloudPulled':
        applyCloudPull(message.data);
        break;
      case 'cloudAck':
        sync.set(
          message.ok
            ? { status: 'synced', lastSyncedAt: message.updatedAt || new Date().toISOString() }
            : { status: 'error' },
        );
        break;
    }
  });

  if (!subscribed) {
    subscribed = true;
    const debouncedSave = debounce(saveNow, SAVE_DEBOUNCE_MS);
    store.$subscribe(() => debouncedSave());

    // Mirror the passphrase (entered in Settings) to the host and react to changes.
    sync.set({ cloudEnabled: cloudEnabled() });
    sendCloudConfig();
    let lastKey = sync.syncKey;
    sync.$subscribe(() => {
      if (sync.syncKey === lastKey) return;
      lastKey = sync.syncKey;
      sync.set({ cloudEnabled: cloudEnabled(), status: cloudEnabled() ? 'syncing' : 'idle' });
      sendCloudConfig();
      cloudSyncedJson = null; // force a push of the current preset under the new key
      saveNow();
    });
  }

  // Ask the host for the file to edit (host replies with 'load').
  post({ type: 'ready' });
}
