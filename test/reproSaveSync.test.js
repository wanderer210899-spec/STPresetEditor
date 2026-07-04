// Extension file webview: the OPEN preset must sync BOTH ways, like the web app.
// Faithful host: conditional PUT (409 on baseUpdatedAt mismatch) + read-merge-
// write. Opening a file links it to a stable library entry (openFileAsPreset),
// so edits push automatically and cloud changes flow back into the open editor.

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
          const conditional = 'baseUpdatedAt' in m;
          if (conditional && m.baseUpdatedAt != null && m.baseUpdatedAt !== this.cloud.updatedAt) {
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
function webWrites(entries) {
  host.pushCount += 1;
  host.cloud = {
    updatedAt: new Date(Date.now() + 1000 + host.pushCount).toISOString(),
    data: {
      ...(host.cloud.data || {}),
      savedPresets: { ...(host.cloud.data.savedPresets || {}), ...entries },
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
  window.acquireVsCodeApi = () => host.api; // isVsCodeHost() true; __STPE_MODE__ undefined => file mode
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
  host.connected = true;
  host.cloud = { updatedAt: '2026-01-01T00:00:00.000Z', data: { savedPresets: {} } };
  preset.savedPresets = {};
  preset.currentPresetId = null;
  sync.set({ lastSyncedAt: null, pendingSync: false, status: 'idle', cloudEnabled: false });
});

// Open a local file exactly like the host bridge does: parse + link to a stable
// library entry keyed by the path.
function openFile(path, content) {
  preset.openFileAsPreset(
    JSON.stringify({
      prompts: [{ identifier: 'p', name: 'P', content, enabled: true }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'p', enabled: true }] }],
    }),
    path.split('/').pop(),
    `file:${path}`,
  );
}

describe('extension open file — two-way sync like web', () => {
  it('A. opening a file auto-pushes its content to the cloud (no explicit save)', async () => {
    await cloud.reconnectCloudSync();
    openFile('/a.json', 'HELLO');
    await wait(2000);
    expect(host.cloud.data.savedPresets['file:/a.json']?.data?.prompts?.p?.content).toBe('HELLO');
  }, 8000);

  it('B. editing the open file syncs the edit up', async () => {
    await cloud.reconnectCloudSync();
    openFile('/a.json', 'HELLO');
    await wait(2000);
    preset.updatePromptDetail({ promptId: 'p', field: 'content', value: 'EDITED' });
    expect(preset.prompts.p.content).toBe('EDITED'); // applied locally at once
    // Edit → 1s autosave debounce → library entry → 1.5s push debounce.
    await wait(3500);
    expect(host.cloud.data.savedPresets['file:/a.json']?.data?.prompts?.p?.content).toBe('EDITED');
  }, 12000);

  it('C. cloud changes to the open preset flow back into the editor (pull)', async () => {
    await cloud.reconnectCloudSync();
    openFile('/a.json', 'HELLO');
    await wait(2000);
    expect(sync.status).toBe('synced');

    // The web edits the SAME preset and stores it in the cloud.
    const cloudEntry = structuredClone(host.cloud.data.savedPresets['file:/a.json']);
    cloudEntry.data.prompts.p.content = 'FROM_WEB';
    cloudEntry.updatedAt = new Date().toISOString();
    webWrites({ 'file:/a.json': cloudEntry });

    await cloud.pollCloudNow(); // tab-focus / 30s poll
    await wait(200);

    // The open editor's active area now reflects the web's change.
    expect(preset.prompts.p.content).toBe('FROM_WEB');
  }, 10000);

  it('D. concurrent web writes never clobber; both presets survive', async () => {
    webWrites({ webp: { id: 'webp', name: 'Web', data: { prompts: {} } } });
    await cloud.reconnectCloudSync();

    openFile('/a.json', 'ONE');
    await wait(2200);
    webWrites({ webp: { id: 'webp', name: 'Web v2', data: { prompts: {} } } }); // cloud moves again
    openFile('/b.json', 'TWO');
    await wait(2500);

    const cp = host.cloud.data.savedPresets;
    expect(cp['file:/a.json']?.data?.prompts?.p?.content).toBe('ONE');
    expect(cp['file:/b.json']?.data?.prompts?.p?.content).toBe('TWO');
    expect(cp.webp?.name).toBe('Web v2'); // the other device's edits are preserved
  }, 14000);
});
