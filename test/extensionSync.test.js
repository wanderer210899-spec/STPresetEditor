// Regression tests for the VS Code extension's cloud LIBRARY sync.
//
// The bug these guard against: the webview talks to the extension host via
// `vscodeApi.postMessage`, which uses the structured-clone algorithm. A snapshot
// taken straight from the Pinia store is made of Vue *reactive proxies*, and
// structuredClone THROWS `DataCloneError` on those — so a push threw before it
// ever left the webview, leaving the status stuck on "syncing…" and the cloud
// never updated. These tests reproduce that boundary faithfully (real
// structuredClone) and assert the push completes.

import { setActivePinia, createPinia } from 'pinia';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// A scriptable stand-in for the extension host (extension.js). Its postMessage
// runs structuredClone(msg) — exactly like the real webview<->host boundary — so
// any non-cloneable payload (e.g. a Vue proxy) fails here just as it would live.
let host;
function dispatch(data) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}
function makeHost() {
  return {
    cloud: { updatedAt: '2026-01-01T00:00:00.000Z', data: { savedPresets: {} } },
    connected: true,
    lastPush: null,
    pushCount: 0,
    api: {
      postMessage(msg) {
        // Faithful boundary: throws DataCloneError on Vue proxies / functions.
        const m = structuredClone(msg);
        queueMicrotask(() => host.handle(m));
      },
    },
    handle(m) {
      switch (m.type) {
        case 'cloudStateRequest':
          dispatch({
            type: 'cloudState',
            url: 'https://w.example',
            connected: this.connected,
            email: 't@t',
          });
          break;
        case 'cloudPullRequest':
          if (!this.connected) return dispatch({ type: 'cloudPulled', connected: false });
          dispatch({
            type: 'cloudPulled',
            connected: true,
            data: this.cloud.data,
            updatedAt: this.cloud.updatedAt,
          });
          break;
        case 'cloudPush':
          // Mirror the host's read-merge-write, then ack.
          this.pushCount += 1;
          this.lastPush = m.data;
          this.cloud = {
            updatedAt: new Date().toISOString(),
            data: { ...(this.cloud.data || {}), ...m.data },
          };
          dispatch({ type: 'cloudAck', ok: true, updatedAt: this.cloud.updatedAt });
          break;
        default:
          break; // ignore ready/save/cloudConnect/etc.
      }
    },
  };
}

let bridge;
let cloud;
let preset;
let sync;

beforeAll(async () => {
  host = makeHost();
  // isVsCodeHost() keys off this being a function; the bridge caches the handle.
  window.acquireVsCodeApi = () => host.api;

  setActivePinia(createPinia());
  bridge = await import('../src/stores/localBridge.js');
  cloud = await import('../src/stores/cloudSync.js');
  const presetMod = await import('../src/stores/presetStore.js');
  const syncMod = await import('../src/stores/syncStore.js');
  preset = presetMod.usePresetStore();
  sync = syncMod.useSyncStore();

  // Registers the window 'message' listener that settles pull/push replies.
  await bridge.initLocalBridge();
});

beforeEach(() => {
  host.lastPush = null;
  host.pushCount = 0;
  host.connected = true;
  host.cloud = { updatedAt: '2026-01-01T00:00:00.000Z', data: { savedPresets: {} } };
});

describe('extension host cloud transport', () => {
  it('hostCloudPut sends a structured-cloneable message for a reactive snapshot', async () => {
    // A snapshot straight from the store contains Vue reactive proxies — the
    // exact shape that used to throw DataCloneError inside postMessage.
    preset.savedPresets = {
      p1: { id: 'p1', name: 'Reactive', prompts: [{ id: 1, content: 'x' }] },
    };
    const snapshot = preset.buildSyncSnapshot();

    const res = await bridge.hostCloudPut({ updatedAt: 'now', data: snapshot });

    expect(res.ok).toBe(true);
    expect(host.pushCount).toBe(1);
    expect(host.lastPush.savedPresets.p1.name).toBe('Reactive');
  });
});

describe('library reconcile (the "Sync library now" / save-then-push flow)', () => {
  it('flushes a locally-saved preset to the cloud and settles on synced', async () => {
    // Pretend we already adopted the (empty) cloud, then the user saves a preset.
    sync.set({ lastSyncedAt: host.cloud.updatedAt, pendingSync: false });
    preset.rawJson = '{"open":"file"}'; // the open file — must NOT be pushed
    preset.savedPresets = { newp: { id: 'newp', name: 'Saved locally', prompts: [] } };
    sync.set({ pendingSync: true });

    await cloud.reconnectCloudSync(); // what "Sync library now" calls

    expect(sync.status).toBe('synced');
    expect(sync.pendingSync).toBe(false);
    expect(host.lastPush).not.toBeNull();
    expect(host.lastPush.savedPresets.newp.name).toBe('Saved locally');
    // The open file stays local: rawJson must never be in the library payload.
    expect('rawJson' in host.lastPush).toBe(false);
  });

  it('stays local-only (no throw) when the host is not connected', async () => {
    host.connected = false;
    await cloud.reconnectCloudSync();
    expect(sync.cloudEnabled).toBe(false);
    expect(host.lastPush).toBeNull();
  });
});
