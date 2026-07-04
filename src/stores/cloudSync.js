import { debounce } from 'lodash-es';
import { hostCloudGet, hostCloudPut, isVsCodeHost, setReconcileHandler } from './localBridge';
import { EXTENSION_LIBRARY_PATHS, usePresetStore } from './presetStore';
import { useSyncStore } from './syncStore';

// The Pages Function endpoint (same origin as the app).
const API_URL = '/api/presets';
// Coalesce rapid edits (typing, dragging) into one upload.
const PUSH_DEBOUNCE_MS = 1500;
// Background pull cadence while the document is visible (F2).
const POLL_INTERVAL_MS = 30000;

// Guards data->cloud echoes while we apply a cloud snapshot locally.
let suppressPush = false;
// JSON of the snapshot currently mirrored in the cloud; used to skip no-op pushes.
let syncedSerialized = null;
// Ensures the change subscription is attached only once across reconnects.
let subscribed = false;
// Ensures the focus/visibility/interval pull triggers are attached only once.
let pollAttached = false;
// Re-entrancy guards: one pull / one conflict dialog at a time.
let pullInFlight = false;
let conflictOpen = false;
// After the user dismisses the conflict dialog (Esc/backdrop = "not now"), the
// 30s poll stops re-prompting; the next edit-triggered push re-opens it.
let conflictDeferred = false;

// Store handles, captured by initCloudSync (module-level so the poll and
// conflict flows can run outside the init call).
let presetRef = null;
let syncRef = null;

// Transport + scope, selected per environment in initCloudSync(). The web app
// talks to /api/presets over its session cookie and syncs the full data set; the
// VS Code extension routes the same reconcile through the host bridge (Node HTTP
// with an API key) and syncs the LIBRARY only (the open file stays local).
let getDoc = fetchCloudDocument;
let putDoc = pushCloudDocument;
let activePaths; // undefined ⇒ buildSyncSnapshot/applyCloudData defaults (full set)
// In the VS Code extension the library is a keyed collection (savedPresets), so a
// concurrent edit from another device (web/mobile) should MERGE, not block on a
// dialog. hostMode routes conflicts through autoRebaseAndPush instead.
let hostMode = false;

/**
 * GET the cloud document (web transport).
 * @returns {Promise<{updatedAt: string|null, data: object|null}|null>}
 *   The document, or null when the cloud is unavailable (so we stay local-only).
 *
 * Auth is the session cookie (account sign-in); `credentials: 'include'` sends
 * it. A 401 (signed out) ⇒ null ⇒ local-only, same as offline.
 */
async function fetchCloudDocument() {
  try {
    // Bound the wait so a hung network can't delay first paint / example load.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(API_URL, {
      headers: { accept: 'application/json' },
      credentials: 'include',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null; // 401 (no Access), 503 (no KV), 404, 5xx -> local-only
    const doc = await res.json();
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null; // offline / network error / timeout
  }
}

/**
 * PUT a snapshot to the cloud (web transport).
 * @returns {Promise<{ok: boolean, conflict?: boolean, updatedAt?: string|null}>}
 *   `conflict: true` when the Worker rejected a conditional write (409) because
 *   another device stored a newer document.
 */
async function pushCloudDocument(payload) {
  try {
    const res = await fetch(API_URL, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    if (res.status === 409) {
      let body = null;
      try {
        body = await res.json();
      } catch {
        // Conflict without a readable body — still a conflict.
      }
      return { ok: false, conflict: true, updatedAt: (body && body.updatedAt) || null };
    }
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

/** Deep-equality by serialization (snapshots are plain JSON data). */
function eq(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * 3-way merge of a keyed collection (savedPresets). Start from the latest
 * REMOTE, then replay every LOCAL change since BASE: entries the user added or
 * edited win; entries the user deleted are removed. Entries only the remote
 * touched are preserved. This makes "add/edit a preset on one device" survive a
 * concurrent change on another instead of clobbering it.
 */
function mergeCollection(base = {}, local = {}, remote = {}) {
  const result = { ...remote };
  const ids = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  for (const id of ids) {
    const inLocal = Object.prototype.hasOwnProperty.call(local, id);
    if (eq(local[id], base[id])) continue; // local didn't touch it → keep remote's
    if (inLocal)
      result[id] = local[id]; // local added/edited → local wins
    else delete result[id]; // local deleted → drop it
  }
  return result;
}

/**
 * Rebase the local library snapshot onto the latest remote one. savedPresets is
 * merged per entry; every other library key (prefs, custom dictionaries, current
 * preset id) takes the local value when the user changed it, otherwise the
 * remote value. No data loss for non-overlapping edits.
 */
function rebaseSnapshot(base, local, remote, paths) {
  const merged = {};
  const keys = paths || Object.keys(local || {});
  for (const key of keys) {
    if (key === 'savedPresets') {
      merged[key] = mergeCollection(base?.[key], local?.[key], remote?.[key]);
    } else if (!eq(local?.[key], base?.[key])) {
      merged[key] = local?.[key]; // user changed this pref locally → keep it
    } else if (remote && key in remote) {
      merged[key] = remote[key]; // untouched locally → adopt remote's
    } else {
      merged[key] = local?.[key];
    }
  }
  return merged;
}

/**
 * Extension conflict resolution (no dialog): pull the latest cloud, rebase the
 * local library on top, adopt the merge, and push it back. Retries if the cloud
 * moves again mid-merge. The library is a keyed collection, so concurrent edits
 * from another device merge cleanly — which is why the web app's keep-mine /
 * keep-theirs prompt is wrong here.
 */
async function autoRebaseAndPush(preset, sync) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const doc = await getDoc();
    if (!doc || !doc.data) {
      sync.set({ status: 'error', pendingSync: true });
      return;
    }
    const base = syncedSerialized ? JSON.parse(syncedSerialized) : {};
    const local = preset.buildSyncSnapshot(activePaths);
    const merged = rebaseSnapshot(base, local, doc.data, activePaths);

    // Adopt the merged library locally (without echoing a push).
    suppressPush = true;
    preset.applyCloudData(merged, activePaths);
    preset.reloadActiveFromLibrary(); // reflect the merge in the open editor + disk
    suppressPush = false;
    const serialized = JSON.stringify(preset.buildSyncSnapshot(activePaths));

    sync.set({ status: 'syncing' });
    const updatedAt = new Date().toISOString();
    const res = await putDoc({ updatedAt, data: merged, baseUpdatedAt: doc.updatedAt });
    if (res && res.conflict) continue; // cloud moved again → rebase onto the newer copy

    const ok = typeof res === 'boolean' ? res : Boolean(res && res.ok);
    const storedAt = (res && res.updatedAt) || updatedAt;
    if (ok) {
      syncedSerialized = serialized;
      sync.set({ status: 'synced', lastSyncedAt: storedAt, pendingSync: false });
    } else {
      sync.set({ status: 'error', pendingSync: true });
    }
    return;
  }
  sync.set({ status: 'error', pendingSync: true }); // gave up after repeated races
}

/**
 * Upload the current local snapshot (no-op if it already matches the cloud).
 * Sends `baseUpdatedAt` so the Worker can 409 instead of clobbering another
 * device's newer copy. A 409 auto-merges in the extension (keyed library) and
 * opens the keep-mine/keep-theirs dialog on the web.
 *
 * Works for both transports: each resolves to `{ ok, conflict?, updatedAt? }`
 * (the host PUT stamps its own updatedAt during read-merge-write).
 */
async function pushNow(preset, sync) {
  if (conflictOpen) return; // the dialog's outcome decides what gets pushed

  // Flush the pending autosave first so the snapshot includes the newest edits
  // (no-op in host mode, where the open file is mirrored to disk instead).
  preset._touchActivePreset();

  const snapshot = preset.buildSyncSnapshot(activePaths);
  const serialized = JSON.stringify(snapshot);

  if (serialized === syncedSerialized) {
    sync.set({ pendingSync: false, status: 'synced' });
    return;
  }

  sync.set({ status: 'syncing' });
  const updatedAt = new Date().toISOString();
  const res = await putDoc({ updatedAt, data: snapshot, baseUpdatedAt: sync.lastSyncedAt });

  if (res && res.conflict) {
    if (hostMode) {
      await autoRebaseAndPush(preset, sync); // extension: merge, never block
      return;
    }
    conflictDeferred = false; // an actual push attempt always re-prompts
    await openConflictDialog();
    return;
  }

  const ok = typeof res === 'boolean' ? res : Boolean(res && res.ok);
  const storedAt = (res && res.updatedAt) || updatedAt;

  if (ok) {
    syncedSerialized = serialized;
    sync.set({ status: 'synced', lastSyncedAt: storedAt, pendingSync: false });
  } else {
    sync.set({ status: 'error', pendingSync: true });
  }
}

/** Push the local snapshot unconditionally (the "keep mine" override — no
 *  `baseUpdatedAt`, so the Worker blind-writes like pre-F2 clients). */
async function forcePush(preset, sync) {
  const snapshot = preset.buildSyncSnapshot(activePaths);
  const serialized = JSON.stringify(snapshot);
  sync.set({ status: 'syncing' });
  const updatedAt = new Date().toISOString();
  const res = await putDoc({ updatedAt, data: snapshot });
  const ok = typeof res === 'boolean' ? res : Boolean(res && res.ok);
  const storedAt = (res && res.updatedAt) || updatedAt;
  if (ok) {
    syncedSerialized = serialized;
    sync.set({ status: 'synced', lastSyncedAt: storedAt, pendingSync: false });
  } else {
    sync.set({ status: 'error', pendingSync: true });
  }
}

/** Adopt a cloud document wholesale (discarding any un-pushed local edits). */
function adoptCloud(preset, sync, doc) {
  suppressPush = true;
  preset.applyCloudData(doc.data, activePaths);
  // The extension syncs the library only, so applyCloudData updates the entries
  // but not the open editor's active area — reload it so the open preset (and its
  // mirrored .json on disk) reflect the adopted cloud changes, like the web app.
  if (hostMode) preset.reloadActiveFromLibrary();
  suppressPush = false;
  syncedSerialized = JSON.stringify(preset.buildSyncSnapshot(activePaths));
  sync.set({ status: 'synced', lastSyncedAt: doc.updatedAt, pendingSync: false });
}

/**
 * Both sides changed: ask the user which version wins (F2).
 * Confirm = keep this device's version (force push). Cancel button = use the
 * cloud version. Dismissing (Esc/backdrop) defers — nothing is lost, the status
 * shows "conflict", and the next edit-triggered push re-opens the dialog.
 */
async function openConflictDialog() {
  const preset = presetRef;
  const sync = syncRef;
  if (!preset || !sync || conflictOpen) return;
  conflictOpen = true;
  sync.set({ status: 'conflict', pendingSync: true });

  // Fetch a fresh cloud copy so "use cloud" adopts exactly what we describe.
  const doc = await getDoc();
  if (!doc || !doc.updatedAt || !doc.data) {
    // Cloud vanished mid-conflict (signed out / offline); retry on next push.
    conflictOpen = false;
    sync.set({ status: 'error' });
    return;
  }

  let when = doc.updatedAt;
  try {
    when = new Date(doc.updatedAt).toLocaleString();
  } catch {
    // Fall back to the raw ISO timestamp.
  }

  preset.requestConfirm({
    title: preset.t('sync.conflict.title'),
    message: preset.t('sync.conflict.message', { time: when }),
    confirmLabel: preset.t('sync.conflict.keepMine'),
    cancelLabel: preset.t('sync.conflict.useCloud'),
    onConfirm: () => {
      conflictOpen = false;
      forcePush(preset, sync);
    },
    onCancel: () => {
      conflictOpen = false;
      adoptCloud(preset, sync, doc);
    },
    onDismiss: () => {
      conflictOpen = false;
      conflictDeferred = true; // keep local edits pending; re-prompt on next push
    },
  });
}

/**
 * Background pull (F2): if the cloud moved and we have no un-pushed local
 * edits, adopt it silently; if both sides changed, run the conflict flow.
 * Exported for tests; wired to focus/visibility/interval by startAutoPull().
 */
export async function pollCloudNow() {
  const preset = presetRef;
  const sync = syncRef;
  if (!preset || !sync || !sync.cloudEnabled) return;
  if (pullInFlight || conflictOpen) return;
  if (typeof document !== 'undefined' && document.hidden) return;

  pullInFlight = true;
  try {
    const doc = await getDoc();
    if (!doc || !doc.updatedAt || !doc.data) return;
    if (doc.updatedAt === sync.lastSyncedAt) return;
    if (sync.pendingSync) {
      // Both sides changed. The extension merges the keyed library automatically;
      // the web asks (but not every 30s after an explicit "not now").
      if (hostMode) await autoRebaseAndPush(preset, sync);
      else if (!conflictDeferred) await openConflictDialog();
      return;
    }
    adoptCloud(preset, sync, doc);
  } finally {
    pullInFlight = false;
  }
}

/** Attach the F2 pull triggers once: tab refocus, visibility, 30s interval. */
function startAutoPull() {
  if (pollAttached || typeof window === 'undefined' || typeof document === 'undefined') return;
  pollAttached = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollCloudNow();
  });
  window.addEventListener('focus', () => pollCloudNow());
  setInterval(() => pollCloudNow(), POLL_INTERVAL_MS); // pollCloudNow skips while hidden
}

/**
 * Initialise cloud sync: reconcile local <-> cloud once, then push on every
 * subsequent data change. Safe no-op (local-only) when the cloud is unreachable
 * or — in the extension — when no API key is connected yet.
 *
 * The same reconcile drives the web app and the VS Code extension; only the
 * transport (web fetch vs host bridge) and the synced scope differ.
 */
export async function initCloudSync() {
  const host = isVsCodeHost();
  hostMode = host;
  getDoc = host ? hostCloudGet : fetchCloudDocument;
  putDoc = host ? hostCloudPut : pushCloudDocument;
  activePaths = host ? EXTENSION_LIBRARY_PATHS : undefined;
  if (host) setReconcileHandler(reconnectCloudSync);

  const preset = usePresetStore();
  const sync = useSyncStore();
  presetRef = preset;
  syncRef = sync;

  const doc = await getDoc();
  if (!doc) {
    // Web: offline / signed out. Extension: no API key connected yet.
    sync.set({ cloudEnabled: false, status: host ? 'idle' : 'offline' });
    return; // local-only; no subscription needed
  }
  sync.set({ cloudEnabled: true });

  const cloudHasData = doc.data && typeof doc.data === 'object';
  const cloudIsNewer = cloudHasData && doc.updatedAt && doc.updatedAt !== sync.lastSyncedAt;

  if (!cloudHasData) {
    // Cloud is empty. Seed it only if this device already has real data.
    // (Web also counts a loaded rawJson; the extension's rawJson is the open
    // local file, which is never synced — so only saved presets count there.)
    const hasLocalData = host
      ? Object.keys(preset.savedPresets || {}).length > 0
      : Boolean(preset.rawJson) || Object.keys(preset.savedPresets || {}).length > 0;
    if (hasLocalData) {
      await pushNow(preset, sync);
    } else {
      syncedSerialized = JSON.stringify(preset.buildSyncSnapshot(activePaths));
      sync.set({ status: 'synced' });
    }
  } else if (cloudIsNewer && !sync.pendingSync) {
    // Adopt the newer cloud copy (no un-pushed local edits to protect).
    adoptCloud(preset, sync, doc);
  } else if (sync.pendingSync || cloudIsNewer) {
    // Local has un-pushed edits: try a conditional push. If the cloud moved
    // too, the 409 path opens the conflict dialog instead of clobbering.
    await pushNow(preset, sync);
  } else {
    // Already in sync with the cloud.
    syncedSerialized = JSON.stringify(preset.buildSyncSnapshot(activePaths));
    sync.set({ status: 'synced' });
  }

  // Push (debounced) whenever the portable data changes — attach once.
  // flush:'sync' fires the callback DURING the mutation, so the suppressPush
  // guard around applyCloudData actually covers it (the default pre-flush runs
  // on the next tick, after the guard has been lifted).
  if (!subscribed) {
    subscribed = true;
    const debouncedPush = debounce(() => pushNow(presetRef, syncRef), PUSH_DEBOUNCE_MS);
    preset.$subscribe(
      () => {
        if (suppressPush || !sync.cloudEnabled) return;
        if (!sync.pendingSync) sync.set({ pendingSync: true });
        debouncedPush();
      },
      { flush: 'sync' },
    );
  }

  startAutoPull();
}

/**
 * Re-run reconciliation after credentials change (web sign-in/out, or the
 * extension connecting/disconnecting an API key). Safe to call repeatedly.
 */
export async function reconnectCloudSync() {
  syncedSerialized = null; // force a fresh pull/seed with the new credentials
  await initCloudSync();
}
