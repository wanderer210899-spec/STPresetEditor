// REPRO: extension file-mode — saving/editing a preset must reach the cloud
// across realistic multi-device sequences. Faithful host: conditional PUT
// (409 on baseUpdatedAt mismatch) + read-merge-write, exactly like extension.js.

import { setActivePinia, createPinia } from 'pinia';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

let host;
function dispatch(data) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}
function makeHost() {
  return {
    cloud: { updatedAt: '2026-01-01T00:00:00.000Z', data: { savedPresets: {} } },
    connected: true,
    pushCount: 0,
    conflictCount: 0,
    api: {
      postMessage(msg) {
        const m = structuredClone(msg);
        queueMicrotask(() => host.handle(m));
      },
    },
    handle(m) {
      switch (m.type) {
        case 'cloudStateRequest':
          dispatch({ type: 'cloudState', url: 'https://w', connected: this.connected, email: 'e' });
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
        case 'cloudPush': {
          // Faithful conditional write: reject if the base the client edited from
          // no longer matches the current cloud version.
          const conditional = 'baseUpdatedAt' in m;
          if (conditional && m.baseUpdatedAt != null && m.baseUpdatedAt !== this.cloud.updatedAt) {
            this.conflictCount += 1;
            dispatch({
              type: 'cloudAck',
              ok: false,
              conflict: true,
              updatedAt: this.cloud.updatedAt,
            });
            return;
          }
          this.pushCount += 1;
          this.cloud = {
            updatedAt: new Date(Date.now() + this.pushCount).toISOString(),
            data: { ...(this.cloud.data || {}), ...m.data },
          };
          dispatch({ type: 'cloudAck', ok: true, updatedAt: this.cloud.updatedAt });
          break;
        }
        default:
          break;
      }
    },
  };
}

// Another device (the web) writes to the same cloud out-of-band.
function webPushes(entry) {
  host.pushCount += 1;
  host.cloud = {
    updatedAt: new Date(Date.now() + 1000 + host.pushCount).toISOString(),
    data: {
      ...(host.cloud.data || {}),
      savedPresets: { ...(host.cloud.data.savedPresets || {}), ...entry },
    },
  };
}

let bridge;
let cloud;
let preset;
let sync;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  host = makeHost();
  window.acquireVsCodeApi = () => host.api;
  setActivePinia(createPinia());
  bridge = await import('../src/stores/localBridge.js');
  cloud = await import('../src/stores/cloudSync.js');
  const presetMod = await import('../src/stores/presetStore.js');
  const syncMod = await import('../src/stores/syncStore.js');
  preset = presetMod.usePresetStore();
  sync = syncMod.useSyncStore();
  await bridge.initLocalBridge();
});

beforeEach(() => {
  host.pushCount = 0;
  host.conflictCount = 0;
  host.connected = true;
  host.cloud = { updatedAt: '2026-01-01T00:00:00.000Z', data: { savedPresets: {} } };
  preset.savedPresets = {};
  preset.currentPresetId = null;
  sync.set({ lastSyncedAt: null, pendingSync: false, status: 'idle', cloudEnabled: false });
});

function openFile(content) {
  preset.parseFromJson(
    JSON.stringify({
      prompts: [{ identifier: 'p', name: 'P', content, enabled: true }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'p', enabled: true }] }],
    }),
  );
}

describe('REPRO: file-mode save reaches the cloud', () => {
  it('A. fresh extension + empty cloud: save pushes content', async () => {
    await cloud.reconnectCloudSync();
    openFile('HELLO');
    const id = preset.saveActivePresetAsCopy('One');
    await wait(2000);
    expect(host.cloud.data.savedPresets[id]?.data?.prompts?.p?.content).toBe('HELLO');
  }, 8000);

  it('B. cloud moved out-of-band (mobile web): the extension save still syncs, and nothing is lost', async () => {
    // Web already has a preset in the cloud; extension adopts it on connect.
    webPushes({ webp: { id: 'webp', name: 'Web', data: { prompts: {} } } });
    await cloud.reconnectCloudSync();
    expect(sync.status).toBe('synced');

    // Web edits again (cloud moves) while the extension sits idle.
    webPushes({ webp: { id: 'webp', name: 'Web v2', data: { prompts: {} } } });

    // Now the user saves a preset in the extension.
    openFile('WORLD');
    const id = preset.saveActivePresetAsCopy('Two');
    await wait(2500);

    // The new preset's content reached the cloud (no conflict stall)…
    expect(host.cloud.data.savedPresets[id]?.data?.prompts?.p?.content).toBe('WORLD');
    // …and the other device's newer preset was preserved (merge, not clobber).
    expect(host.cloud.data.savedPresets.webp?.name).toBe('Web v2');
    expect(sync.status).toBe('synced');
  }, 12000);

  it('C. repeated saves keep syncing while the cloud keeps moving', async () => {
    webPushes({ webp: { id: 'webp', name: 'Web', data: { prompts: {} } } });
    await cloud.reconnectCloudSync();

    openFile('ONE');
    const id1 = preset.saveActivePresetAsCopy('First');
    await wait(2200);
    webPushes({ webp: { id: 'webp', name: 'Web v2', data: { prompts: {} } } }); // web moves again
    openFile('TWO');
    const id2 = preset.saveActivePresetAsCopy('Second');
    await wait(2500);

    const cp = host.cloud.data.savedPresets;
    expect(cp[id1]?.data?.prompts?.p?.content).toBe('ONE'); // first save survived
    expect(cp[id2]?.data?.prompts?.p?.content).toBe('TWO'); // second save synced
    expect(cp.webp?.name).toBe('Web v2'); // web's edits never lost
  }, 14000);
});
