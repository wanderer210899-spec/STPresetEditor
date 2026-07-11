import { debounce } from 'lodash-es';
import { hostCloudGet, hostCloudPut, isVsCodeHost, setReconcileHandler } from './localBridge';
import { EXTENSION_LIBRARY_PATHS, SYNC_DATA_PATHS, usePresetStore } from './presetStore';
import { useSyncStore } from './syncStore';

// The Pages Function endpoint (same origin as the app).
const API_URL = '/api/presets';
// Coalesce rapid edits (typing, dragging) into one upload.
const PUSH_DEBOUNCE_MS = 1500;
// Upper bound: the store's own follow-up mutations (macro analysis, the 1s
// autosave flush) re-arm the trailing debounce after every edit, so without a
// maxWait a long editing session would starve the push indefinitely — and a
// window closed in that gap leaves pendingSync stranded (the RC5/RC2 combo).
const PUSH_MAX_WAIT_MS = 3000;
// Background pull cadence while the document is visible (F2).
const POLL_INTERVAL_MS = 30000;
// The merge BASE (last snapshot known to match the cloud) persists across
// reloads; without it every restart merges against nothing and "local wins
// everywhere" clobbers the other device's edits (RC2).
const SYNC_BASE_KEY = 'stpe:sync:base';
// Active-document keys where a concurrent change on BOTH sides is a real
// conflict a human should arbitrate (web transport only — the extension never
// syncs these top-level; its open file rides inside its savedPresets entry).
const ACTIVE_CONFLICT_KEYS = ['rawJson', 'prompts', 'promptOrder'];

// Guards data->cloud echoes while we apply a cloud snapshot locally.
let suppressPush = false;
// JSON of the snapshot currently mirrored in the cloud — the 3-way merge base.
// Loaded from localStorage on init, updated on every successful sync.
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
// with an API key) and syncs the LIBRARY only (the open file stays in its
// savedPresets entry).
let getDoc = fetchCloudDocument;
let putDoc = pushCloudDocument;
let activePaths; // undefined ⇒ buildSyncSnapshot/applyCloudData defaults (full set)
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

/** Snapshot-shaped view of a cloud document limited to the synced paths, so it
 *  serializes comparably to buildSyncSnapshot output. */
function pickSnapshot(data, paths) {
  const snap = {};
  for (const key of paths) snap[key] = data?.[key];
  return snap;
}

// --- Merge base persistence (RC2) --------------------------------------------

function loadSyncedBase() {
  try {
    return window.localStorage.getItem(SYNC_BASE_KEY);
  } catch {
    return null; // storage unavailable — in-memory base only
  }
}

function setSyncedBase(serialized) {
  syncedSerialized = serialized;
  try {
    window.localStorage.setItem(SYNC_BASE_KEY, serialized);
  } catch {
    // Quota / unavailable: degrade to in-memory (pre-fix behavior).
  }
}

function clearSyncedBase() {
  syncedSerialized = null;
  try {
    window.localStorage.removeItem(SYNC_BASE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Parse the current base, or null when there is none / it is corrupt. */
function parsedBase() {
  if (!syncedSerialized) return null;
  try {
    return JSON.parse(syncedSerialized);
  } catch {
    return null;
  }
}

/**
 * 3-way merge of a keyed collection (savedPresets). Start from the latest
 * REMOTE, then replay every LOCAL change since BASE: entries the user added or
 * edited win; entries the user deleted are removed. Entries only the remote
 * touched are preserved.
 *
 * When an entry has no BASE record (fresh install, cleared storage) edits and
 * history are indistinguishable, so we fall back to heuristics: local-only
 * entries are kept, remote-only entries are kept, and when both sides differ
 * the newer `updatedAt` wins (missing timestamps ⇒ remote wins — the safer
 * default for an unknown device).
 */
function mergeCollection(base = {}, local = {}, remote = {}) {
  const result = { ...remote };
  const ids = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  for (const id of ids) {
    const inBase = Object.prototype.hasOwnProperty.call(base, id);
    const inLocal = Object.prototype.hasOwnProperty.call(local, id);
    const inRemote = Object.prototype.hasOwnProperty.call(remote, id);
    if (inBase) {
      if (eq(local[id], base[id])) continue; // local didn't touch it → keep remote's
      if (inLocal)
        result[id] = local[id]; // local added/edited → local wins
      else delete result[id]; // local deleted → drop it
    } else {
      if (!inLocal) continue; // remote-only → keep remote's
      if (!inRemote) {
        result[id] = local[id]; // local-only → keep it
        continue;
      }
      if (eq(local[id], remote[id])) continue;
      const localAt = Date.parse(local[id]?.updatedAt || '') || 0;
      const remoteAt = Date.parse(remote[id]?.updatedAt || '') || 0;
      if (localAt > remoteAt) result[id] = local[id];
    }
  }
  return result;
}

/**
 * Rebase the local snapshot onto the latest remote one. savedPresets is merged
 * per entry; every other key takes the local value when the user changed it
 * since BASE, otherwise the remote value. Keys with no base record prefer the
 * remote value (cloud is authoritative for an unknown device). No data loss for
 * non-overlapping edits.
 */
function rebaseSnapshot(base, local, remote, paths) {
  const merged = {};
  const keys = paths || Object.keys(local || {});
  for (const key of keys) {
    const baseHasKey = base && typeof base === 'object' && key in base;
    if (key === 'savedPresets') {
      merged[key] = mergeCollection(base?.[key] || {}, local?.[key], remote?.[key]);
    } else if (baseHasKey && !eq(local?.[key], base[key])) {
      merged[key] = local?.[key]; // user changed this locally → keep it
    } else if (remote && key in remote) {
      merged[key] = remote[key]; // untouched locally (or unknown) → adopt remote's
    } else {
      merged[key] = local?.[key];
    }
  }
  return merged;
}

/** True when the open DOCUMENT changed on both sides since base — the only
 *  divergence the web app asks a human about. Without a base, any divergence
 *  in the document keys counts (we can't attribute it). */
function activeAreaConflict(base, local, remote) {
  if (!base) {
    return ACTIVE_CONFLICT_KEYS.some((key) => !eq(local?.[key], remote?.[key]));
  }
  return ACTIVE_CONFLICT_KEYS.some(
    (key) =>
      !eq(local?.[key], base?.[key]) &&
      !eq(remote?.[key], base?.[key]) &&
      !eq(local?.[key], remote?.[key]),
  );
}

/**
 * Reconcile a divergence (local edits + a cloud that moved) without losing
 * either side: pull the latest cloud, rebase the local snapshot on top
 * (per-entry merge for savedPresets), adopt the merge locally, and push it
 * back conditionally. Retries if the cloud moves again mid-merge.
 *
 * The web app gets one extra step: when the open DOCUMENT itself changed on
 * both sides (a real fork), the keep-mine / use-cloud dialog decides —
 * `skipDialog` is set when the user already chose "keep mine". The extension
 * never dialogs: its synced scope is the keyed library, which merges cleanly.
 */
async function resolveDivergence(preset, sync, { skipDialog = false } = {}) {
  if (conflictOpen) return; // the open dialog's outcome decides what happens
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const doc = await getDoc();
    if (!doc || !doc.data) {
      sync.set({ status: 'error', pendingSync: true });
      return;
    }

    // Flush the pending autosave so the snapshot includes the newest edits.
    preset._touchActivePreset();
    const base = parsedBase();
    const local = preset.buildSyncSnapshot(activePaths);

    if (!hostMode && !skipDialog && activeAreaConflict(base, local, doc.data)) {
      await openConflictDialog(doc);
      return;
    }

    const merged = rebaseSnapshot(base, local, doc.data, activePaths);
    const mergedSerialized = JSON.stringify(merged);

    // Adopt the merge locally (without echoing a push) — skipped when it is
    // already identical to the local state, so undo history survives the
    // common "my edits win" case.
    if (mergedSerialized !== JSON.stringify(local)) {
      suppressPush = true;
      preset.applyCloudData(merged, activePaths);
      // The extension syncs the library only; reload the open editor (and its
      // mirrored .json on disk) so it reflects the just-adopted cloud changes.
      if (hostMode) preset.reloadActiveFromLibrary();
      suppressPush = false;
    }
    const serialized = JSON.stringify(preset.buildSyncSnapshot(activePaths));

    // Pure adoption (nothing local survived that the cloud lacks) → no PUT.
    const paths = activePaths || SYNC_DATA_PATHS;
    if (serialized === JSON.stringify(pickSnapshot(doc.data, paths))) {
      conflictDeferred = false;
      setSyncedBase(serialized);
      sync.set({ status: 'synced', lastSyncedAt: doc.updatedAt, pendingSync: false });
      return;
    }

    sync.set({ status: 'syncing' });
    const updatedAt = new Date().toISOString();
    const res = await putDoc({ updatedAt, data: merged, baseUpdatedAt: doc.updatedAt });
    if (res && res.conflict) continue; // cloud moved again → rebase onto the newer copy

    const ok = typeof res === 'boolean' ? res : Boolean(res && res.ok);
    const storedAt = (res && res.updatedAt) || updatedAt;
    if (ok) {
      conflictDeferred = false;
      setSyncedBase(serialized);
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
 * device's newer copy. A 409 routes into resolveDivergence: merge for the
 * library, dialog only when the open document truly forked (web).
 */
async function pushNow(preset, sync) {
  if (conflictOpen) return; // the dialog's outcome decides what gets pushed

  // Flush the pending autosave first so the snapshot includes the newest edits.
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
    conflictDeferred = false; // an actual push attempt always re-prompts
    await resolveDivergence(preset, sync);
    return;
  }

  const ok = typeof res === 'boolean' ? res : Boolean(res && res.ok);
  const storedAt = (res && res.updatedAt) || updatedAt;

  if (ok) {
    setSyncedBase(serialized);
    sync.set({ status: 'synced', lastSyncedAt: storedAt, pendingSync: false });
  } else {
    sync.set({ status: 'error', pendingSync: true });
  }
}

/** Adopt a cloud document wholesale (discarding any un-pushed local edits).
 *  Used for clean pulls and for the explicit "use cloud version" choice. */
function adoptCloud(preset, sync, doc) {
  suppressPush = true;
  preset.applyCloudData(doc.data, activePaths);
  // The extension syncs the library only, so applyCloudData updates the entries
  // but not the open editor's active area — reload it so the open preset (and its
  // mirrored .json on disk) reflect the adopted cloud changes, like the web app.
  if (hostMode) preset.reloadActiveFromLibrary();
  suppressPush = false;
  conflictDeferred = false;
  setSyncedBase(JSON.stringify(preset.buildSyncSnapshot(activePaths)));
  sync.set({ status: 'synced', lastSyncedAt: doc.updatedAt, pendingSync: false });
}

/**
 * The open document forked (changed here AND in the cloud): ask the user (F2).
 * Confirm = keep this device's version of the document — the library still
 * merges per entry and the result is pushed conditionally (no more blind
 * whole-library overwrite). Cancel button = adopt the cloud copy wholesale.
 * Dismissing (Esc/backdrop) defers — nothing is lost, the status shows
 * "conflict", and the next edit-triggered push re-opens the dialog.
 */
async function openConflictDialog(doc) {
  const preset = presetRef;
  const sync = syncRef;
  if (!preset || !sync || conflictOpen) return;
  conflictOpen = true;
  sync.set({ status: 'conflict', pendingSync: true });

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
      resolveDivergence(preset, sync, { skipDialog: true });
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
 * edits, adopt it silently; if both sides changed, merge (and only a genuine
 * document fork on the web asks the user). Exported for tests; wired to
 * focus/visibility/interval by startAutoPull().
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
      // Both sides changed. Merge — but after an explicit "not now" the 30s
      // poll stays quiet; the next edit-triggered push resolves instead.
      if (!conflictDeferred) await resolveDivergence(preset, sync);
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

  // Restore the persisted merge base so post-restart merges know what this
  // device had already synced (RC2). reconnectCloudSync clears it first when
  // credentials change.
  if (syncedSerialized === null) syncedSerialized = loadSyncedBase();

  const doc = await getDoc();
  if (!doc) {
    // Web: offline / signed out. Extension: no API key connected yet.
    sync.set({ cloudEnabled: false, status: host ? 'idle' : 'offline' });
    return; // local-only; no subscription needed
  }
  sync.set({ cloudEnabled: true });

  const cloudHasData = doc.data && typeof doc.data === 'object';
  const cloudIsNewer = cloudHasData && doc.updatedAt && doc.updatedAt !== sync.lastSyncedAt;
  const paths = activePaths || SYNC_DATA_PATHS;

  if (!cloudHasData) {
    // Cloud is empty. Seed it only if this device already has real data.
    // (Web also counts a loaded rawJson; the extension's open file rides inside
    // its savedPresets entry — so only saved presets count there.)
    const hasLocalData = host
      ? Object.keys(preset.savedPresets || {}).length > 0
      : Boolean(preset.rawJson) || Object.keys(preset.savedPresets || {}).length > 0;
    if (hasLocalData) {
      await pushNow(preset, sync);
    } else {
      setSyncedBase(JSON.stringify(preset.buildSyncSnapshot(activePaths)));
      sync.set({ status: 'synced' });
    }
  } else if (cloudIsNewer && !sync.pendingSync) {
    // The cloud moved and nothing is flagged pending. That flag is not enough
    // on its own: edits made while sync was off never set it (signed-out web
    // tinkering), and the extension links the just-opened DISK file into the
    // library before this subscription attaches (RC1). So compare against the
    // persisted merge base: local changes since the last sync go through the
    // merge path instead of being silently overwritten by a blind adopt.
    const base = parsedBase();
    const local = preset.buildSyncSnapshot(activePaths);
    const localChangedSinceBase = base
      ? paths.some((key) => !eq(local[key], base[key]))
      : host
        ? Object.keys(local.savedPresets || {}).length > 0
        : preset.canUndo && paths.some((key) => !eq(local[key], doc.data?.[key]));
    if (localChangedSinceBase) {
      await resolveDivergence(preset, sync);
    } else {
      adoptCloud(preset, sync, doc);
    }
  } else if (sync.pendingSync || cloudIsNewer) {
    // Local has un-pushed edits: try a conditional push. If the cloud moved
    // too, the 409 path merges (and only a document fork asks the user).
    await pushNow(preset, sync);
  } else {
    // Cloud unchanged since our last sync — but verify before recording
    // "synced": the local data may have moved while sync was off (e.g. the
    // extension's disk file changed between sessions). Recording that state as
    // the base without pushing would orphan the change forever (RC3).
    const serialized = JSON.stringify(preset.buildSyncSnapshot(activePaths));
    if (serialized === JSON.stringify(pickSnapshot(doc.data, paths))) {
      setSyncedBase(serialized);
      sync.set({ status: 'synced' });
    } else {
      await pushNow(preset, sync);
    }
  }

  // Push (debounced) whenever the portable data changes — attach once.
  // flush:'sync' fires the callback DURING the mutation, so the suppressPush
  // guard around applyCloudData actually covers it (the default pre-flush runs
  // on the next tick, after the guard has been lifted). maxWait bounds the
  // wait: derived mutations (analysis, autosave) re-arm the trailing edge, so
  // without it a busy editing session never pushes (RC5).
  if (!subscribed) {
    subscribed = true;
    const debouncedPush = debounce(() => pushNow(presetRef, syncRef), PUSH_DEBOUNCE_MS, {
      maxWait: PUSH_MAX_WAIT_MS,
    });
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
 * The persisted merge base belongs to the previous credentials, so drop it —
 * the fresh reconcile rebuilds it from the new account's cloud document.
 */
export async function reconnectCloudSync() {
  clearSyncedBase();
  await initCloudSync();
}
