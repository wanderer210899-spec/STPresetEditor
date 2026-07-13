import { defineStore } from 'pinia';

/**
 * Holds cloud-storage status only. Kept separate from the data store so that
 * status updates (syncing/synced/etc.) never look like editable-data changes
 * to the data store's change subscription — which would cause push loops.
 *
 * `lastSyncedAt` and `pendingSync` are persisted so that edits made while
 * offline are still recognised (and flushed) after a reload.
 */
export const useSyncStore = defineStore('sync', {
  state: () => ({
    cloudEnabled: false, // Whether the cloud API is reachable/configured
    status: 'idle', // 'idle' | 'syncing' | 'synced' | 'offline' | 'error'
    lastSyncedAt: null, // ISO timestamp of the last successful cloud round-trip
    pendingSync: false, // True when local has changes not yet in the cloud
  }),
  getters: {
    /** Human-friendly label for a status indicator. */
    statusLabel: (state) => {
      if (!state.cloudEnabled) return 'Local only';
      switch (state.status) {
        case 'syncing':
          return 'Syncing…';
        case 'synced':
          return state.pendingSync ? 'Not sent yet' : 'Synced';
        case 'error':
          return 'Sync error';
        case 'offline':
          return 'Offline';
        default:
          return 'Idle';
      }
    },
  },
  actions: {
    set(meta) {
      if (!meta) return;
      if ('cloudEnabled' in meta) this.cloudEnabled = meta.cloudEnabled;
      if ('status' in meta) this.status = meta.status;
      if ('lastSyncedAt' in meta) this.lastSyncedAt = meta.lastSyncedAt;
      if ('pendingSync' in meta) this.pendingSync = meta.pendingSync;
    },
  },
  persist: {
    // v4 uses `pick`, not `paths`. Only persist the offline-edit bookkeeping;
    // transient status (cloudEnabled/status) must be recomputed each load,
    // never restored stale.
    pick: ['lastSyncedAt', 'pendingSync'],
  },
});
