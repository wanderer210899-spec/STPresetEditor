import { defineStore } from 'pinia';

/**
 * Holds cloud-sync status only. Kept separate from the data store so that
 * status updates (syncing/synced/etc.) never look like editable-data changes
 * to the data store's change subscription — which would cause sync loops.
 *
 * `lastSyncedAt` and `pendingSync` are persisted so that edits made while
 * offline are still recognised (and flushed) after a reload.
 */
export const useSyncStore = defineStore('sync', {
  state: () => ({
    cloudEnabled: false, // Whether the cloud API is reachable/configured
    status: 'idle', // 'idle' | 'syncing' | 'synced' | 'offline' | 'error' | 'conflict'
    lastSyncedAt: null, // ISO timestamp of the cloud document we last reconciled with
    pendingSync: false, // True when local has edits not yet pushed to the cloud
    // How the currently-open extension FILE relates to the cloud library. Pushed
    // by the host after each folder reconcile (file webview only). `state` is one
    // of 'synced' | 'pending' | 'conflict' | 'localOnly' | 'unlinked'. `connected`
    // reflects whether the cloud (API key + URL) is configured at all, so the
    // status dot can tell "offline" from "connected but this file isn't linked".
    fileLink: {
      linked: false,
      state: 'unlinked',
      standalone: false,
      fileName: '',
      connected: false,
    },
  }),
  getters: {
    /** Human-friendly label for a status indicator. */
    statusLabel: (state) => {
      if (!state.cloudEnabled) return 'Local only';
      switch (state.status) {
        case 'syncing':
          return 'Syncing…';
        case 'synced':
          return 'Synced';
        case 'error':
          return 'Sync error';
        case 'conflict':
          return 'Sync conflict';
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
      if ('fileLink' in meta) this.fileLink = meta.fileLink;
    },
  },
  persist: {
    // v4 uses `pick`, not `paths`. Only persist the offline-edit bookkeeping;
    // transient status (cloudEnabled/status/fileLink) must be recomputed each
    // load, never restored stale.
    pick: ['lastSyncedAt', 'pendingSync'],
  },
});
