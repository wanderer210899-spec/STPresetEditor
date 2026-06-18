import { debounce } from 'lodash-es';
import { hostCloudGet, hostCloudPut, isVsCodeHost, setReconcileHandler } from './localBridge';
import { EXTENSION_LIBRARY_PATHS, usePresetStore } from './presetStore';
import { useSyncStore } from './syncStore';

// The Pages Function endpoint (same origin as the app).
const API_URL = '/api/presets';
// Coalesce rapid edits (typing, dragging) into one upload.
const PUSH_DEBOUNCE_MS = 1500;

// Guards data->cloud echoes while we apply a cloud snapshot locally.
let suppressPush = false;
// JSON of the snapshot currently mirrored in the cloud; used to skip no-op pushes.
let syncedSerialized = null;
// Ensures the change subscription is attached only once across reconnects.
let subscribed = false;

// Transport + scope, selected per environment in initCloudSync(). The web app
// talks to /api/presets over its session cookie and syncs the full data set; the
// VS Code extension routes the same reconcile through the host bridge (Node HTTP
// with an API key) and syncs the LIBRARY only (the open file stays local).
let getDoc = fetchCloudDocument;
let putDoc = pushCloudDocument;
let activePaths; // undefined ⇒ buildSyncSnapshot/applyCloudData defaults (full set)

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
 * @returns {Promise<boolean>} true on success
 */
async function pushCloudDocument(payload) {
  try {
    const res = await fetch(API_URL, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Upload the current local snapshot (no-op if it already matches the cloud).
 * Works for both transports: the web PUT returns a boolean, the host PUT returns
 * { ok, updatedAt } (the host stamps its own updatedAt during read-merge-write).
 */
async function pushNow(preset, sync) {
  const snapshot = preset.buildSyncSnapshot(activePaths);
  const serialized = JSON.stringify(snapshot);

  if (serialized === syncedSerialized) {
    sync.set({ pendingSync: false, status: 'synced' });
    return;
  }

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
  getDoc = host ? hostCloudGet : fetchCloudDocument;
  putDoc = host ? hostCloudPut : pushCloudDocument;
  activePaths = host ? EXTENSION_LIBRARY_PATHS : undefined;
  if (host) setReconcileHandler(reconnectCloudSync);

  const preset = usePresetStore();
  const sync = useSyncStore();

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
    suppressPush = true;
    preset.applyCloudData(doc.data, activePaths);
    suppressPush = false;
    syncedSerialized = JSON.stringify(preset.buildSyncSnapshot(activePaths));
    sync.set({ status: 'synced', lastSyncedAt: doc.updatedAt, pendingSync: false });
  } else if (sync.pendingSync || cloudIsNewer) {
    // Local is authoritative: flush offline edits (they win over a remote change).
    await pushNow(preset, sync);
  } else {
    // Already in sync with the cloud.
    syncedSerialized = JSON.stringify(preset.buildSyncSnapshot(activePaths));
    sync.set({ status: 'synced' });
  }

  // Push (debounced) whenever the portable data changes — attach once.
  if (!subscribed) {
    subscribed = true;
    const debouncedPush = debounce(() => pushNow(preset, sync), PUSH_DEBOUNCE_MS);
    preset.$subscribe(() => {
      if (suppressPush || !sync.cloudEnabled) return;
      if (!sync.pendingSync) sync.set({ pendingSync: true });
      debouncedPush();
    });
  }
}

/**
 * Re-run reconciliation after credentials change (web sign-in/out, or the
 * extension connecting/disconnecting an API key). Safe to call repeatedly.
 */
export async function reconnectCloudSync() {
  syncedSerialized = null; // force a fresh pull/seed with the new credentials
  await initCloudSync();
}
