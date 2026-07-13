// Local-file bridge + cloud transport for the Cursor/VSCode extension (the "host").
//
// File seam: mirrors the OPEN preset to a local file via the webview <-> host
// postMessage bridge (parseFromJson in, finalJson out). Edits to the open file
// are entirely local — they are never pushed to the cloud automatically.
//
// Cloud transport (explicit actions only): the webview can't ride the web
// app's session cookie (different origin), so the extension authenticates with
// a generated **API key** (`X-API-Key`) the user creates in the web app's
// Settings → Cloud sync. The key is held by the HOST (VS Code SecretStorage),
// never here. This file exposes one-shot request/reply wrappers — list, load,
// send, delete, rename, save-into-workspace — that stores/cloudSync.js and the
// toolbar call for the EXPLICIT cloud actions. There is no background engine.
//
// Protocol (this file <-> extension/extension.js):
//   webview -> host : ready | save{path,json} | createFile{name,json}
//                     | cloudStateRequest | cloudConnect{url,key} | cloudDisconnect
//                     | cloudList | cloudLoad{name}
//                     | cloudSend{name,data,snapshots?,updatedAt,snapshot}
//                     | cloudDelete{name} | cloudRename{oldName,newName}
//                     | saveToWorkspace{name,json}
//   host -> webview : load{...} | fileCreated{ok,path,name,reason}
//                     | cloudState{url,connected,email}
//                     | cloudReady{ok,email,reason,url}
//                     | cloudListResult{connected,presets}
//                     | cloudLoaded{ok,entry} | cloudSent{ok,existed,updatedAt}
//                     | cloudDeleted{ok} | cloudRenamed{ok,updatedAt}
//                     | workspaceSaved{ok,path,fileName,reason}
//                     | shortcut{action}
import { debounce } from 'lodash-es';
import { toPlainClone } from '../utils/clone';
import { isLibraryHost, isVsCodeHost } from '../utils/host';
import { usePresetStore } from './presetStore';
import { useSyncStore } from './syncStore';

// Re-export so existing consumers keep one import site for host detection.
export { isVsCodeHost };

const SAVE_DEBOUNCE_MS = 800;
const REPLY_TIMEOUT_MS = 12000;
// The workspace save opens a folder picker the user may ponder over.
const WORKSPACE_REPLY_TIMEOUT_MS = 120000;

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

// One-shot resolvers awaiting a host reply, keyed by reply kind.
const pending = {
  connect: [],
  state: [],
  file: [],
  list: [],
  load: [],
  send: [],
  delete: [],
  rename: [],
  workspace: [],
};

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
function awaitReply(kind, fallback, timeoutMs = REPLY_TIMEOUT_MS) {
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
    }, timeoutMs);
  });
}

/** Mirror the host's connection snapshot into module + sync-store state. */
function applyConnection({ connected, email, url }) {
  cloudConnected = Boolean(connected);
  cloudEmail = email || '';
  if (typeof url === 'string') cloudUrlValue = url;
  sync.set({ cloudEnabled: cloudConnected });
}

/** Run a host-forwarded shortcut (Ctrl+F/K/S) against the store. Undo/redo are
 *  intentionally NOT forwarded so native text editing keeps its own undo. */
function handleShortcut(action) {
  if (!store) return;
  switch (action) {
    case 'find': {
      const el = typeof document !== 'undefined' && document.getElementById('editor-search-input');
      if (el) {
        el.focus();
        el.select?.();
      }
      break;
    }
    case 'globalSearch':
      store.openGlobalSearch();
      break;
    case 'save':
      if (isLibraryHost()) {
        // The cloud browser's Save = write the preset into a workspace folder.
        saveActiveToWorkspace().then((res) => {
          if (res?.ok) {
            store.showToast(store.t('toolbar.savedToWorkspace', { file: res.fileName }), 'success');
          } else if (res?.reason && res.reason !== 'cancelled') {
            store.showToast(store.t('toolbar.saveToWorkspaceFailed'), 'error');
          }
        });
      } else if (store.saveActivePreset()) {
        store.showToast(store.t('toolbar.saved'), 'success');
      }
      break;
    default:
      break;
  }
}

// --- File seam ---------------------------------------------------------------

/** Stable library id for a local file, derived from its path so reopening the
 *  same file maps to the same local entry (snapshots survive reopens). */
function filePresetId(path) {
  return path ? `file:${path}` : '';
}

/** Apply a preset file pushed from the host. The open file is linked to a
 *  stable LOCAL library entry so autosave/snapshots work like the web app;
 *  nothing about that entry reaches the cloud without the explicit Send. */
function applyLoad(message) {
  if (typeof message.json !== 'string') return;
  if (message.path) activePath = message.path;
  const presetId = filePresetId(activePath);
  if (presetId) {
    store.openFileAsPreset(message.json, message.name, presetId); // parse + link + analyze
  } else {
    store.parseFromJson(message.json); // no path (shouldn't happen) — stay unlinked
    if (message.name) store.originalFilename = message.name;
  }
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

/**
 * Ask the host to write a preset JSON to a NEW file next to the open one and
 * open it in its own editor tab. Used by the Preset Manager in file mode so
 * loading a library preset never overwrites the open file on disk.
 * Resolves to { ok, path?, name?, reason? }.
 */
export function createPresetFile(name, json) {
  if (!isVsCodeHost()) return Promise.resolve({ ok: false, reason: 'not_host' });
  post({ type: 'createFile', name: name || '', json: json || '' });
  return awaitReply('file', { ok: false, reason: 'timeout' });
}

// --- Cloud transport (explicit actions; used by stores/cloudSync.js) ----------

/** GET the cloud index. Resolves to [{name, updatedAt}] or null when the cloud
 *  is not connected / unreachable (⇒ local-only). */
export function hostCloudList() {
  if (!isVsCodeHost()) return Promise.resolve(null);
  post({ type: 'cloudList' });
  return awaitReply('list', null).then((msg) => {
    if (!msg || !msg.connected || !Array.isArray(msg.presets)) return null;
    return msg.presets;
  });
}

/** GET one named cloud preset. Resolves to the stored record or null. */
export function hostCloudLoad(name) {
  if (!isVsCodeHost()) return Promise.resolve(null);
  post({ type: 'cloudLoad', name });
  return awaitReply('load', null).then((msg) => (msg && msg.ok && msg.entry ? msg.entry : null));
}

/**
 * PUT one named cloud preset (create or replace — newest wins). `snapshot`
 * asks the worker to keep the replaced version as a restorable snapshot (the
 * explicit "Send to cloud" semantics). Resolves to { ok, updatedAt?, existed? }.
 */
export function hostCloudSend(name, payload, { snapshot = false } = {}) {
  if (!isVsCodeHost()) return Promise.resolve({ ok: false });
  // Store values are Vue reactive PROXIES — postMessage (structured clone)
  // throws DataCloneError on those. Serialise to plain JSON-safe data first.
  const plain = toPlainClone(payload || {});
  post({
    type: 'cloudSend',
    name,
    data: plain.data,
    snapshots: plain.snapshots,
    updatedAt: plain.updatedAt,
    snapshot: Boolean(snapshot),
  });
  return awaitReply('send', { ok: false }).then((msg) => ({
    ok: Boolean(msg && msg.ok),
    updatedAt: msg && msg.updatedAt,
    existed: Boolean(msg && msg.existed),
  }));
}

/** DELETE one named cloud preset. Resolves to { ok }. */
export function hostCloudDelete(name) {
  if (!isVsCodeHost()) return Promise.resolve({ ok: false });
  post({ type: 'cloudDelete', name });
  return awaitReply('delete', { ok: false }).then((msg) => ({ ok: Boolean(msg && msg.ok) }));
}

/** Rename a cloud preset (read old → write new → delete old, host-side).
 *  Resolves to { ok, updatedAt? }. */
export function hostCloudRename(oldName, newName) {
  if (!isVsCodeHost()) return Promise.resolve({ ok: false });
  post({ type: 'cloudRename', oldName, newName });
  return awaitReply('rename', { ok: false }).then((msg) => ({
    ok: Boolean(msg && msg.ok),
    updatedAt: msg && msg.updatedAt,
  }));
}

/**
 * The cloud browser's Save button: write the OPEN preset into a workspace
 * folder the user picks (host shows the picker). A same-named file in that
 * folder is overwritten — name = identity, never a second copy.
 * Resolves to { ok, path?, fileName?, reason? } ('cancelled' when dismissed).
 */
export function saveActiveToWorkspace() {
  if (!isVsCodeHost()) return Promise.resolve({ ok: false, reason: 'not_host' });
  const json = store?.finalJson || '';
  const base =
    (store?.currentPresetName || '').trim() ||
    (store?.originalFilename || '').replace(/\.[^/.]+$/, '').trim();
  if (!json || !base) return Promise.resolve({ ok: false, reason: 'empty' });
  post({ type: 'saveToWorkspace', name: `${base}.json`, json });
  return awaitReply('workspace', { ok: false, reason: 'timeout' }, WORKSPACE_REPLY_TIMEOUT_MS);
}

/**
 * Initialise the host file bridge: receive the open file and mirror edits back
 * to disk (debounced). Cloud actions are handled by the explicit wrappers
 * above. No-op outside a webview.
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
      case 'cloudListResult':
        settle('list', message);
        break;
      case 'cloudLoaded':
        settle('load', message);
        break;
      case 'cloudSent':
        settle('send', message);
        break;
      case 'cloudDeleted':
        settle('delete', message);
        break;
      case 'cloudRenamed':
        settle('rename', message);
        break;
      case 'workspaceSaved':
        settle('workspace', message);
        break;
      case 'fileCreated':
        settle('file', message);
        break;
      case 'shortcut':
        // A keybinding VS Code would otherwise swallow (Ctrl+F/K/S), forwarded by
        // the host so shortcuts work like the web app.
        handleShortcut(message.action);
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
