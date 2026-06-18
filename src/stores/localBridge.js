// Local-file + cloud bridge for the Cursor/VSCode extension (the "host").
//
// File side: the file-backed sibling of cloudSync.js — mirrors the open preset
// to a local file via the webview <-> host postMessage bridge (parseFromJson in,
// finalJson out).
//
// Cloud side (A4 — account auth): the HOST does the Cloudflare HTTP (Node, no
// CORS, never the browser). The webview can't ride the web app's session cookie
// (different origin), so the extension authenticates with a generated **API key**
// (`X-API-Key`) the user creates in the web app's Settings → Cloud sync. The key
// is held by the host (VS Code SecretStorage), NOT here — this file only asks the
// host to connect/validate and learns the result ("connected as <email>"). Two
// independent baselines keep file and cloud from echoing into each other:
//   • fileSyncedJson  — finalJson last written to disk
//   • cloudSyncedJson — library payload last pushed to the cloud
//
// Protocol (this file <-> extension/extension.js):
//   webview -> host : ready | save{path,json} | cloudStateRequest
//                     | cloudConnect{url,key} | cloudDisconnect | cloudPush{data}
//                     | cloudPullRequest
//   host -> webview : load{...} | cloudState{url,connected,email}
//                     | cloudReady{ok,email,reason,url} | cloudPulled{data} | cloudAck{ok,updatedAt}
import { debounce } from 'lodash-es';
import { usePresetStore } from './presetStore';
import { useSyncStore } from './syncStore';

const SAVE_DEBOUNCE_MS = 800;
const REPLY_TIMEOUT_MS = 12000;

let vscodeApi = null;
let subscribed = false;
let activePath = null;
let fileSyncedJson = null;
let cloudSyncedJson = null;
let store = null;
let sync = null;

// Connection state, mirrored from the host (the host owns the credential).
let cloudConnected = false;
let cloudEmail = '';
let cloudUrlValue = '';

// One-shot resolvers awaiting a host reply, keyed by reply kind.
const pending = { connect: [], state: [] };

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

/** Resolve everyone waiting on a given reply kind. */
function settle(kind, value) {
  const waiters = pending[kind];
  pending[kind] = [];
  waiters.forEach((resolve) => resolve(value));
}

/** Promise that resolves on the next host reply of `kind` (or a timeout fallback). */
function awaitReply(kind, fallback) {
  return new Promise((resolve) => {
    let timer = null;
    const done = (value) => {
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    pending[kind].push(done);
    timer = setTimeout(() => {
      const idx = pending[kind].indexOf(done);
      if (idx !== -1) pending[kind].splice(idx, 1);
      resolve(fallback);
    }, REPLY_TIMEOUT_MS);
  });
}

function cloudEnabled() {
  return cloudConnected;
}

/** Mirror the host's connection snapshot into module + sync-store state. */
function applyConnection({ connected, email, url }) {
  cloudConnected = Boolean(connected);
  cloudEmail = email || '';
  if (typeof url === 'string') cloudUrlValue = url;
  sync.set({ cloudEnabled: cloudConnected, status: cloudConnected ? 'synced' : 'idle' });
}

/**
 * The portable library (saved presets + prefs) in cloud-document shape, built
 * from EXTENSION_LIBRARY_PATHS. The open file's active-area fields (rawJson,
 * prompts, …) are deliberately excluded: the cloud is the central drive for the
 * LIBRARY only, never the file you are editing. The host's read-merge-write
 * overlays just these keys, leaving the rest of the cloud document untouched.
 */
function libraryPayload() {
  return store.buildLibrarySnapshot();
}

/** Apply a preset file pushed from the host. Opening neither rewrites the file
 *  nor pushes to the cloud (both baselines are set to the just-loaded state). */
function applyLoad(message) {
  if (typeof message.json !== 'string') return;
  if (message.path) activePath = message.path;
  store.parseFromJson(message.json); // also runs analyzeAllMacros()
  if (message.name) store.originalFilename = message.name;
  fileSyncedJson = store.finalJson;
  cloudSyncedJson = JSON.stringify(libraryPayload());
}

/** Adopt the LIBRARY pulled from the cloud (saved presets + prefs). Never touches
 *  the open file — library paths exclude rawJson/prompts. Baseline is reset so the
 *  store change this triggers does not echo a push back up. */
function applyCloudPull(data) {
  if (!data || typeof data !== 'object') {
    sync.set({ status: 'synced' });
    return;
  }
  store.applyLibraryData(data);
  cloudSyncedJson = JSON.stringify(libraryPayload());
  sync.set({ status: 'synced', lastSyncedAt: new Date().toISOString() });
}

/** Debounced mirror to both targets; each guarded so unchanged content is a no-op.
 *  The open file mirrors to disk; the library mirrors to the cloud. Opening or
 *  pulling never pushes; only a real edit pushes. */
function saveNow() {
  if (activePath) {
    const json = store.finalJson;
    if (json !== fileSyncedJson) {
      fileSyncedJson = json;
      post({ type: 'save', path: activePath, json });
    }
  }
  if (cloudEnabled()) {
    const serialized = JSON.stringify(libraryPayload());
    if (serialized !== cloudSyncedJson) {
      cloudSyncedJson = serialized;
      sync.set({ status: 'syncing' });
      // Post a plain clone (not the Vue reactive proxy) for a safe structured clone.
      post({ type: 'cloudPush', data: JSON.parse(serialized) });
    }
  }
}

// --- Public API for the <SyncSetup> panel (extension mode) -------------------

/**
 * Ask the host to connect the cloud with a URL + API key. Resolves to
 * { ok, email, reason } once the host validates the key against the worker.
 */
export function connectCloud(url, key) {
  if (!isVsCodeHost()) return Promise.resolve({ ok: false, reason: 'not_host' });
  post({ type: 'cloudConnect', url: url || '', key: key || '' });
  return awaitReply('connect', { ok: false, reason: 'timeout' });
}

/** Ask the host to forget the stored API key (drop to local-only). */
export function disconnectCloud() {
  if (!isVsCodeHost()) return Promise.resolve({ ok: false });
  post({ type: 'cloudDisconnect' });
  return awaitReply('connect', { ok: false, reason: 'timeout' });
}

/** Ask the host for the current cloud config (URL to prefill + connection state). */
export function requestCloudState() {
  if (!isVsCodeHost()) return Promise.resolve({ url: '', connected: false, email: '' });
  post({ type: 'cloudStateRequest' });
  return awaitReply('state', { url: cloudUrlValue, connected: cloudConnected, email: cloudEmail });
}

/** Ask the host to fetch the cloud library now and push it down (manual sync).
 *  The host replies with a 'cloudPulled' message handled by applyCloudPull. */
export function pullLibraryNow() {
  if (!isVsCodeHost() || !cloudEnabled()) return;
  sync.set({ status: 'syncing' });
  post({ type: 'cloudPullRequest' });
}

/**
 * Initialise the host bridge: receive the file, then mirror edits to the file
 * and (once the host confirms a valid API key) to the cloud. No-op outside a
 * webview.
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
      case 'cloudState':
        applyConnection({ connected: message.connected, email: message.email, url: message.url });
        settle('state', { url: cloudUrlValue, connected: cloudConnected, email: cloudEmail });
        break;
      case 'cloudReady':
        applyConnection({ connected: message.ok, email: message.email, url: message.url });
        settle('connect', {
          ok: Boolean(message.ok),
          email: cloudEmail,
          reason: message.reason || '',
        });
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
  }

  // Ask the host for the file to edit (host replies with 'load' + 'cloudState').
  post({ type: 'ready' });
}
