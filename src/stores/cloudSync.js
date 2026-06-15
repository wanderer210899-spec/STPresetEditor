import { debounce } from 'lodash-es';
import { usePresetStore } from './presetStore';
import { useSyncStore } from './syncStore';

// The Pages Function endpoint (same origin as the app).
const API_URL = '/api/presets';
// Coalesce rapid edits (typing, dragging) into one upload.
const PUSH_DEBOUNCE_MS = 1500;

// Guards data->cloud echoes while we apply a cloud snapshot locally.
let suppressPush = false;
// JSON of the snapshot currently mirrored in the cloud; used to skip no-op pushes.
let syncedSerialized = null;

/**
 * GET the cloud document.
 * @returns {Promise<{updatedAt: string|null, data: object|null}|null>}
 *   The document, or null when the cloud is unavailable (so we stay local-only).
 */
async function fetchCloudDocument() {
  try {
    const res = await fetch(API_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) return null; // 503 (KV not configured), 404, 5xx -> local-only
    const doc = await res.json();
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null; // offline / network error
  }
}

/**
 * PUT a snapshot to the cloud.
 * @returns {Promise<boolean>} true on success
 */
async function pushCloudDocument(payload) {
  try {
    const res = await fetch(API_URL, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Upload the current local snapshot (no-op if it already matches the cloud).
 */
async function pushNow(preset, sync) {
  const snapshot = preset.buildSyncSnapshot();
  const serialized = JSON.stringify(snapshot);

  if (serialized === syncedSerialized) {
    sync.set({ pendingSync: false, status: 'synced' });
    return;
  }

  sync.set({ status: 'syncing' });
  const updatedAt = new Date().toISOString();
  const ok = await pushCloudDocument({ updatedAt, data: snapshot });

  if (ok) {
    syncedSerialized = serialized;
    sync.set({ status: 'synced', lastSyncedAt: updatedAt, pendingSync: false });
  } else {
    sync.set({ status: 'error', pendingSync: true });
  }
}

/**
 * Initialise cloud sync: reconcile local <-> cloud once, then push on every
 * subsequent data change. Safe no-op (local-only) when the API is unreachable,
 * so `npm run dev` and pre-KV deploys keep working unchanged.
 */
export async function initCloudSync() {
  const preset = usePresetStore();
  const sync = useSyncStore();

  const doc = await fetchCloudDocument();
  if (!doc) {
    sync.set({ cloudEnabled: false, status: 'offline' });
    return; // local-only; no subscription needed
  }
  sync.set({ cloudEnabled: true });

  const cloudHasData = doc.data && typeof doc.data === 'object';
  const cloudIsNewer = cloudHasData && doc.updatedAt && doc.updatedAt !== sync.lastSyncedAt;

  if (!cloudHasData) {
    // Cloud is empty -> seed it from this device.
    await pushNow(preset, sync);
  } else if (cloudIsNewer && !sync.pendingSync) {
    // Adopt the newer cloud copy (no un-pushed local edits to protect).
    suppressPush = true;
    preset.applyCloudData(doc.data);
    suppressPush = false;
    syncedSerialized = JSON.stringify(preset.buildSyncSnapshot());
    sync.set({ status: 'synced', lastSyncedAt: doc.updatedAt, pendingSync: false });
  } else if (sync.pendingSync || cloudIsNewer) {
    // Local is authoritative: flush offline edits (they win over a remote change).
    await pushNow(preset, sync);
  } else {
    // Already in sync with the cloud.
    syncedSerialized = JSON.stringify(preset.buildSyncSnapshot());
    sync.set({ status: 'synced' });
  }

  // Push (debounced) whenever the portable data changes from here on.
  const debouncedPush = debounce(() => pushNow(preset, sync), PUSH_DEBOUNCE_MS);
  preset.$subscribe(() => {
    if (suppressPush || !sync.cloudEnabled) return;
    if (!sync.pendingSync) sync.set({ pendingSync: true });
    debouncedPush();
  });
}
