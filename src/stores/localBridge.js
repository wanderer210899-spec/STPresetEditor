// Local-file bridge + cloud transport for the Cursor/VSCode extension (the "host").
//
// File seam: mirrors the OPEN preset to a local file via the webview <-> host
// postMessage bridge (parseFromJson in, finalJson out). The open file is LOCAL —
// it is never synced to the cloud.
//
// Cloud transport (A4 — account auth): the webview can't ride the web app's
// session cookie (different origin), so the extension authenticates with a
// generated **API key** (`X-API-Key`) the user creates in the web app's
// Settings → Cloud sync. The key is held by the HOST (VS Code SecretStorage),
// never here. This file does NOT orchestrate cloud sync; it (a) connects /
// validates the key with the host and (b) exposes `hostCloudGet()` /
// `hostCloudPut()` so the SHARED engine in cloudSync.js can reconcile the preset
// LIBRARY (saved presets + prefs) over the host's Node HTTP — exactly like the
// web app, just with a different transport.
//
// Protocol (this file <-> extension/extension.js):
//   webview -> host : ready | save{path,json} | cloudStateRequest
//                     | cloudConnect{url,key} | cloudDisconnect
//                     | cloudPullRequest | cloudPush{data}
//   host -> webview : load{...} | cloudState{url,connected,email}
//                     | cloudReady{ok,email,reason,url}
//                     | cloudPulled{connected,data,updatedAt} | cloudAck{ok,updatedAt}
//                     | cloudReconcile  (status-bar "Sync library" → re-reconcile)
import { debounce } from 'lodash-es';
import { usePresetStore } from './presetStore';
import { useSyncStore } from './syncStore';

const SAVE_DEBOUNCE_MS = 800;
const REPLY_TIMEOUT_MS = 12000;

let vscodeApi = null;
let subscribed = false;
let activePath = null;
let fileSyncedJson = null; // finalJson last written to disk (file-seam baseline)
let store = null;
let sync = null;

// Connection state, mirrored from the host (the host owns the credential).
let cloudConnected = false;
let cloudEmail = '';
let cloudUrlValue = '';

// Invoked when the host asks the webview to re-reconcile (status-bar "Sync
// library"). cloudSync.js registers it in host mode; avoids a circular import.
let reconcileHandler = null;

// One-shot resolvers awaiting a host reply, keyed by reply kind.
const pending = { connect: [], state: [], pull: [], push: [] };

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

/** Mirror the host's connection snapshot into module + sync-store state. The
 *  authoritative sync STATUS is owned by cloudSync.js (the reconcile engine);
 *  here we only reflect whether a credential is present. */
function applyConnection({ connected, email, url }) {
  cloudConnected = Boolean(connected);
  cloudEmail = email || '';
  if (typeof url === 'string') cloudUrlValue = url;
  sync.set({ cloudEnabled: cloudConnected });
}

// --- File seam ---------------------------------------------------------------

/** Apply a preset file pushed from the host. Opening does not rewrite the file
 *  (the baseline is set to the just-loaded state). */
function applyLoad(message) {
  if (typeof message.json !== 'string') return;
  if (message.path) activePath = message.path;
  store.parseFromJson(message.json); // also runs analyzeAllMacros()
  if (message.name) store.originalFilename = message.name;
  fileSyncedJson = store.finalJson;
}

/** Debounced mirror of the open file to disk (skips no-op / echo writes). */
function saveFileNow() {
  if (!activePath) return;
  const json = store.finalJson;
  if (json === fileSyncedJson) return;
  fileSyncedJson = json;
  post({ type: 'save', path: activePath, json });
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

/** Register the callback the status-bar "Sync library" command triggers. */
export function setReconcileHandler(fn) {
  reconcileHandler = fn;
}

// --- Cloud transport for cloudSync.js (host mode) ----------------------------

/**
 * GET the cloud document via the host. Mirrors cloudSync.fetchCloudDocument:
 * resolves to `{ updatedAt, data }` when connected (data may be null for an
 * empty cloud), or `null` when not connected / unreachable (⇒ local-only).
 */
export function hostCloudGet() {
  if (!isVsCodeHost()) return Promise.resolve(null);
  post({ type: 'cloudPullRequest' });
  return awaitReply('pull', null).then((msg) => {
    if (!msg || !msg.connected) return null;
    return { updatedAt: msg.updatedAt || null, data: msg.data || null };
  });
}

/**
 * PUT a snapshot to the cloud via the host (host does the read-merge-write so
 * only the library keys we send are overlaid). Resolves to `{ ok, updatedAt }`.
 */
export function hostCloudPut(payload) {
  if (!isVsCodeHost()) return Promise.resolve({ ok: false });
  // The snapshot comes straight from the Pinia store, so its values are Vue
  // reactive PROXIES — and `postMessage` (structured clone) throws DataCloneError
  // on those. Serialise to a plain, JSON-safe object before crossing the bridge
  // (the same normalisation the web transport gets for free via JSON.stringify).
  const data = toPlain(payload && payload.data);
  post({ type: 'cloudPush', data });
  return awaitReply('push', { ok: false }).then((msg) => ({
    ok: Boolean(msg && msg.ok),
    updatedAt: msg && msg.updatedAt,
  }));
}

/** Deep-clone to a plain, structured-clone-safe object (strips Vue proxies). */
function toPlain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Initialise the host file bridge: receive the open file and mirror edits back
 * to disk (debounced). Cloud sync is handled separately by cloudSync.js using
 * the transport above. No-op outside a webview.
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
        settle('pull', message);
        break;
      case 'cloudAck':
        settle('push', message);
        break;
      case 'cloudReconcile':
        if (reconcileHandler) reconcileHandler();
        break;
    }
  });

  if (!subscribed) {
    subscribed = true;
    const debouncedSave = debounce(saveFileNow, SAVE_DEBOUNCE_MS);
    store.$subscribe(() => debouncedSave());
  }

  // Ask the host for the file to edit (host replies with 'load' + 'cloudState').
  post({ type: 'ready' });
}
