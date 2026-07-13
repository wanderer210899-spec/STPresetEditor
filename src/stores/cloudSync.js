// Cloud storage client — "storage + explicit save" (2026-07 rewrite).
//
// The cloud is passive NAMED storage: one record per preset, keyed by the
// preset's NAME (see worker/index.js). This module replaces the old automatic
// whole-library sync engine (3-way merges, conflict dialogs, background polls)
// with a small per-preset client. What runs depends on the runtime:
//
//   web       — keeps today's UX: the library mirrors the cloud. On load,
//               a per-name newest-wins reconcile; afterwards, edits auto-save
//               to the open preset's entry and a debounced diff push uploads
//               changed entries (and propagates explicit deletes/renames).
//               No merge protocol: a preset name is only ever overwritten
//               wholesale, newest wins.
//   library   — the VS Code "cloud browser" webview. On load it mirrors the
//               cloud list locally so the Preset Manager can browse/open it.
//               NOTHING is pushed automatically: content only reaches the
//               cloud through the explicit "Send to cloud" action. Explicit
//               management actions (delete, rename) hit the cloud immediately
//               via the store's cloud hooks.
//   file      — the VS Code file editor. No cloud engine at all: edits stay in
//               the local file; the only cloud affordance is the explicit
//               "Send to cloud" button (which talks straight to the host).
//
// Duplicate prevention is structural: every write targets one name, so two
// devices can never fork one preset into two records. The only bookkeeping is
// a tiny persisted map of what this client last pushed/adopted per name — it
// distinguishes "new local preset → upload it" from "deleted in the cloud →
// remove it locally" (never resurrect), and detects unpushed local edits.

import { debounce } from 'lodash-es';
import { toPlainClone } from '../utils/clone';
import { getEditorMode, isFileHost, isVsCodeHost } from '../utils/host';
import { setCloudLibraryHooks } from './cloudHooks';
import {
  hostCloudDelete,
  hostCloudList,
  hostCloudLoad,
  hostCloudRename,
  hostCloudSend,
} from './localBridge';
import { usePresetStore } from './presetStore';
import { useSyncStore } from './syncStore';

// The Worker endpoint (same origin as the web app).
const API_BASE = '/api/presets';
// Coalesce rapid edits (typing, dragging) into one upload (web only).
const PUSH_DEBOUNCE_MS = 1500;
// The store's own follow-up mutations (macro analysis, the 1s autosave flush)
// re-arm the trailing debounce; without a maxWait a long editing session would
// never push.
const PUSH_MAX_WAIT_MS = 4000;
// name -> { at, sig } of the last state this client pushed to / adopted from
// the cloud. Persisted so delete-detection survives reloads.
const PUSHED_KEY = 'stpe:cloud:pushed';

// Store handles, captured by initCloudSync.
let presetRef = null;
let syncRef = null;

// Ensures the web change subscription is attached only once across reconnects.
let subscribed = false;
// Re-entrancy guard: no diff pushes while a reconcile is adopting cloud data.
let busy = false;

// name -> { at: entry.updatedAt in the cloud, sig: local entry signature }.
let pushed = {};

// --- Web transport ------------------------------------------------------------

/** Fetch with a bounded wait so a hung network can't delay first paint. */
async function webFetch(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(path, { credentials: 'include', signal: controller.signal, ...options });
  } finally {
    clearTimeout(timeout);
  }
}

const webTransport = {
  /** @returns {Promise<Array<{name,updatedAt}>|null>} null ⇒ signed out / offline. */
  async list() {
    try {
      const res = await webFetch(API_BASE, { headers: { accept: 'application/json' } });
      if (!res.ok) return null; // 401 (signed out), 503 (no KV), 5xx → local-only
      const body = await res.json();
      return Array.isArray(body?.presets) ? body.presets : null;
    } catch {
      return null; // offline / network error / timeout
    }
  },
  /** @returns {Promise<{name,updatedAt,data,snapshots}|null>} */
  async load(name) {
    try {
      const res = await webFetch(`${API_BASE}/${encodeURIComponent(name)}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return null;
      const body = await res.json();
      return body && typeof body === 'object' && body.data ? body : null;
    } catch {
      return null;
    }
  },
  /** @returns {Promise<{ok, updatedAt?, existed?}>} */
  async put(name, payload, { snapshot = false } = {}) {
    try {
      const res = await fetch(
        `${API_BASE}/${encodeURIComponent(name)}${snapshot ? '?snapshot=1' : ''}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) return { ok: false };
      const body = await res.json().catch(() => ({}));
      return { ok: true, updatedAt: body.updatedAt, existed: Boolean(body.existed) };
    } catch {
      return { ok: false };
    }
  },
  /** @returns {Promise<{ok}>} */
  async remove(name) {
    try {
      const res = await fetch(`${API_BASE}/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      return { ok: res.ok };
    } catch {
      return { ok: false };
    }
  },
  rename: null, // web renames decompose into put(new) + remove(old) in the diff push
};

const hostTransport = {
  list: hostCloudList,
  load: hostCloudLoad,
  put: hostCloudSend,
  remove: hostCloudDelete,
  rename: hostCloudRename,
};

function transport() {
  return isVsCodeHost() ? hostTransport : webTransport;
}

// --- Pushed-state bookkeeping ---------------------------------------------------

function loadPushed() {
  try {
    const raw = window.localStorage.getItem(PUSHED_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    pushed = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    pushed = {}; // storage unavailable / corrupt — in-memory only
  }
}

function savePushed() {
  try {
    window.localStorage.setItem(PUSHED_KEY, JSON.stringify(pushed));
  } catch {
    // Quota / unavailable: degrade to in-memory bookkeeping.
  }
}

function clearPushed() {
  pushed = {};
  try {
    window.localStorage.removeItem(PUSHED_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Cheap change signature for one entry: bumps on content saves (updatedAt)
 *  AND on snapshot list changes (which don't touch updatedAt). */
function entrySignature(entry) {
  const snaps = (entry.snapshots || []).map((s) => `${s?.id}:${s?.name}`).join(',');
  return `${entry.updatedAt || ''}|${snaps}`;
}

/** Local library keyed by name. Duplicate names (legacy data) resolve to the
 *  newest entry — name = identity, so only one copy can own the cloud record. */
function localEntriesByName(preset) {
  const byName = new Map();
  for (const [id, entry] of Object.entries(preset.savedPresets || {})) {
    if (!entry?.name) continue;
    const prev = byName.get(entry.name);
    if (!prev || Date.parse(entry.updatedAt || '') > Date.parse(prev.entry.updatedAt || '')) {
      byName.set(entry.name, { id, entry });
    }
  }
  return byName;
}

/** Upload body for one entry: the web library syncs its snapshot list too. */
function entryPayload(entry) {
  return toPlainClone({
    data: entry.data,
    snapshots: entry.snapshots || [],
    updatedAt: entry.updatedAt,
  });
}

/** Record a name as in-sync with the cloud. */
function markSynced(name, cloudUpdatedAt, entry) {
  pushed[name] = { at: cloudUpdatedAt || '', sig: entry ? entrySignature(entry) : null };
}

// --- Reconcile (startup / explicit refresh) -------------------------------------

/**
 * Per-name, newest-wins reconcile of the local library against the cloud index.
 * `autoPush` (web) additionally uploads local-side changes; the cloud browser
 * (library mode) never pushes here — it only adopts, and keeps local-only /
 * locally-newer entries untouched as "not sent yet".
 *
 * Delete semantics: a local name that is missing from the cloud but present in
 * the pushed map was deleted on another device — it is removed locally, never
 * resurrected. A name the cloud never saw is new — uploaded (web) or kept
 * local (library).
 * @returns {Promise<boolean>} whether the cloud was reachable
 */
async function reconcile(preset, sync, { autoPush }) {
  const index = await transport().list();
  if (!index) {
    sync.set({ cloudEnabled: false, status: isVsCodeHost() ? 'idle' : 'offline' });
    return false;
  }
  sync.set({ cloudEnabled: true, status: 'syncing' });
  busy = true;
  let ok = true;
  let pendingLocal = false;
  try {
    const cloudByName = new Map(index.map((p) => [p.name, p]));
    const localByName = localEntriesByName(preset);

    for (const [name, cloud] of cloudByName) {
      const local = localByName.get(name);
      const base = pushed[name];

      // Not here yet → adopt.
      if (!local) {
        const record = await transport().load(name);
        if (record) {
          const id = preset.adoptCloudEntry(record);
          markSynced(name, record.updatedAt, id ? preset.savedPresets[id] : null);
        } else ok = false;
        continue;
      }

      const localAt = local.entry.updatedAt || '';
      const localSig = entrySignature(local.entry);
      if (localAt === cloud.updatedAt && (!base || base.sig === localSig)) {
        markSynced(name, cloud.updatedAt, local.entry);
        continue; // in sync
      }

      // Which side moved since this client last synced the name?
      let localChanged;
      if (base) {
        localChanged = base.sig !== localSig;
        const cloudChanged = base.at !== cloud.updatedAt;
        if (localChanged && cloudChanged) {
          // Both moved → newest wins (no merge, no dialog).
          localChanged = (Date.parse(localAt) || 0) >= (Date.parse(cloud.updatedAt) || 0);
        } else if (!localChanged && !cloudChanged) {
          markSynced(name, cloud.updatedAt, local.entry);
          continue;
        } else if (!localChanged) {
          localChanged = false; // only the cloud moved → adopt below
        }
      } else {
        // Unknown to this client → newest wins.
        localChanged = (Date.parse(localAt) || 0) >= (Date.parse(cloud.updatedAt) || 0);
      }

      if (localChanged) {
        if (autoPush) {
          const res = await transport().put(name, entryPayload(local.entry));
          if (res?.ok) markSynced(name, res.updatedAt, local.entry);
          else ok = false;
        } else {
          pendingLocal = true; // cloud browser: local changes wait for "Send"
        }
      } else {
        const record = await transport().load(name);
        if (record) {
          const id = preset.adoptCloudEntry(record);
          markSynced(name, record.updatedAt, id ? preset.savedPresets[id] : null);
        } else ok = false;
      }
    }

    // Names that exist locally but not in the cloud.
    for (const [name, local] of localByName) {
      if (cloudByName.has(name)) continue;
      if (pushed[name]) {
        // This client once synced it and the cloud no longer has it: it was
        // deleted elsewhere. Remove it locally — deletes must stick.
        preset.removeLibraryEntryByName(name);
        delete pushed[name];
      } else if (autoPush) {
        const res = await transport().put(name, entryPayload(local.entry));
        if (res?.ok) markSynced(name, res.updatedAt, local.entry);
        else ok = false;
      } else {
        pendingLocal = true; // not sent yet — keep it local
      }
    }

    // Drop map records for names gone from BOTH sides (deleted while offline).
    for (const name of Object.keys(pushed)) {
      if (!cloudByName.has(name) && !localEntriesByName(preset).has(name)) delete pushed[name];
    }
  } finally {
    busy = false;
    savePushed();
  }

  sync.set({
    status: ok ? 'synced' : 'error',
    lastSyncedAt: new Date().toISOString(),
    pendingSync: !ok || pendingLocal,
  });
  return true;
}

// --- Web diff push (automatic, debounced) ---------------------------------------

/**
 * Upload every locally-changed entry and delete cloud records whose local
 * entry disappeared (both detected against the pushed map). Web only — this
 * is what keeps the web app's auto-save UX: the open preset's autosaved entry
 * goes dirty, and this pushes it under its name, newest wins.
 */
async function syncDirtyEntries() {
  const preset = presetRef;
  const sync = syncRef;
  if (!preset || !sync || !sync.cloudEnabled || busy) return;
  busy = true;
  let ok = true;
  let touched = false;
  try {
    preset._touchActivePreset(); // flush the pending autosave first

    const localByName = localEntriesByName(preset);
    for (const [name, { entry }] of localByName) {
      if (pushed[name] && pushed[name].sig === entrySignature(entry)) continue;
      touched = true;
      sync.set({ status: 'syncing' });
      const res = await transport().put(name, entryPayload(entry));
      if (res?.ok) markSynced(name, res.updatedAt, entry);
      else ok = false;
    }

    for (const name of Object.keys(pushed)) {
      if (localByName.has(name)) continue;
      touched = true;
      sync.set({ status: 'syncing' });
      const res = await transport().remove(name);
      if (res?.ok) delete pushed[name];
      else ok = false;
    }
  } finally {
    busy = false;
    if (touched) savePushed();
  }
  sync.set(
    ok
      ? { status: 'synced', lastSyncedAt: new Date().toISOString(), pendingSync: false }
      : { status: 'error', pendingSync: true },
  );
}

// --- Cloud-browser hooks (explicit management actions) ---------------------------

function registerLibraryHooks() {
  setCloudLibraryHooks({
    onDeleted(name) {
      // Fire-and-forget: the local entry is already gone; a failure just means
      // the record re-appears on the next refresh (the cloud stays truthful).
      transport()
        .remove(name)
        .then((res) => {
          if (res?.ok) {
            delete pushed[name];
            savePushed();
          } else {
            presetRef?.showToast?.(presetRef.t('sync.deleteFailed', { name }), 'error');
          }
        });
    },
    onRenamed(oldName, newName) {
      const rename = transport().rename;
      if (!rename) return;
      rename(oldName, newName).then((res) => {
        if (res?.ok) {
          delete pushed[oldName];
          const entry = localEntriesByName(presetRef).get(newName)?.entry;
          markSynced(newName, res.updatedAt, entry);
          savePushed();
        } else {
          presetRef?.showToast?.(presetRef.t('sync.renameFailed', { name: oldName }), 'error');
        }
      });
    },
  });
}

// --- Public API -------------------------------------------------------------------

/**
 * Initialise the cloud client for this runtime. Web: reconcile then subscribe
 * the debounced diff push. Library (cloud browser): mirror the cloud list and
 * register the explicit delete/rename hooks. File editor: nothing — its only
 * cloud affordance is the explicit send, which needs no engine.
 */
export async function initCloudSync() {
  const mode = getEditorMode();
  if (mode === 'file') return;

  const preset = usePresetStore();
  const sync = useSyncStore();
  presetRef = preset;
  syncRef = sync;
  loadPushed();

  if (mode === 'library') registerLibraryHooks();

  const reachable = await reconcile(preset, sync, { autoPush: mode === 'web' });
  if (!reachable) return; // local-only; nothing to subscribe

  if (mode === 'web' && !subscribed) {
    subscribed = true;
    const debouncedPush = debounce(() => syncDirtyEntries(), PUSH_DEBOUNCE_MS, {
      maxWait: PUSH_MAX_WAIT_MS,
    });
    // flush:'sync' fires DURING the mutation, so the `busy` guard around
    // reconcile/adopt actually covers the callback (the default pre-flush runs
    // on the next tick, after the guard lifted).
    preset.$subscribe(
      () => {
        if (busy || !sync.cloudEnabled) return;
        if (!sync.pendingSync) sync.set({ pendingSync: true });
        debouncedPush();
      },
      { flush: 'sync' },
    );
    // A tab closed mid-debounce would strand the last edit — flush on the way out.
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => debouncedPush.flush());
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) debouncedPush.flush();
      });
    }
  }
}

/**
 * Explicit "refresh from cloud": re-run the reconcile now. Used by the toolbar
 * status button and the Preset Manager's refresh action.
 * @returns {Promise<boolean>} whether the cloud was reachable
 */
export async function refreshCloudLibrary() {
  const mode = getEditorMode();
  if (mode === 'file' || !presetRef || !syncRef) return false;
  return reconcile(presetRef, syncRef, { autoPush: mode === 'web' });
}

/**
 * Explicit "Send to cloud" (VS Code, both interfaces): upload the OPEN preset
 * under its name. Same name in the cloud ⇒ newest wins, and the worker keeps
 * the replaced version as a restorable snapshot (`?snapshot=1`). Never
 * duplicates: one name, one record.
 * @returns {Promise<{ok: boolean, name?: string, existed?: boolean, reason?: string}>}
 */
export async function sendActivePresetToCloud() {
  const preset = presetRef || usePresetStore();
  const sync = syncRef || useSyncStore();
  const id = preset.saveActivePreset(); // flush edits into the library entry
  const entry = id ? preset.savedPresets[id] : null;
  if (!entry) return { ok: false, reason: 'empty' };

  // The cloud identity: in the file editor the FILE's base name (that is the
  // preset the user is looking at); in the cloud browser the entry's name.
  const fileBase = (preset.originalFilename || '').replace(/\.[^/.]+$/, '').trim();
  const name = (isFileHost() ? fileBase || entry.name : entry.name || fileBase || '').trim();
  if (!name) return { ok: false, reason: 'noname' };

  sync.set({ status: 'syncing' });
  const res = await transport().put(
    name,
    { data: toPlainClone(entry.data), updatedAt: new Date().toISOString() },
    { snapshot: true },
  );
  if (!res?.ok) {
    sync.set({ status: 'error' });
    return { ok: false, reason: 'network' };
  }

  // Cloud browser: re-adopt the stored record so the local mirror carries the
  // worker-kept snapshot of the replaced version.
  if (getEditorMode() === 'library') {
    const record = await transport().load(name);
    if (record) {
      busy = true;
      try {
        const adoptedId = preset.adoptCloudEntry(record);
        markSynced(name, record.updatedAt, adoptedId ? preset.savedPresets[adoptedId] : null);
        savePushed();
      } finally {
        busy = false;
      }
    }
  }

  sync.set({ status: 'synced', lastSyncedAt: new Date().toISOString() });
  return { ok: true, name, existed: Boolean(res.existed) };
}

/**
 * Re-run initialisation after credentials change (web sign-in/out, extension
 * key connect/disconnect). The pushed map belongs to the previous credentials,
 * so drop it — the fresh reconcile rebuilds it from the new account's library.
 */
export async function reconnectCloudSync() {
  clearPushed();
  await initCloudSync();
}
