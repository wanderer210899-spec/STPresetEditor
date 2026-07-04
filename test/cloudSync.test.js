// Phase 2 (F2) — client-side automatic sync: silent adoption on poll, and the
// conflict flow (keep mine / use cloud / dismiss-defers) against an in-memory
// fetch mock that mirrors the Worker's conditional-PUT semantics.

import { randomUUID } from 'node:crypto';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

if (typeof window.crypto?.randomUUID !== 'function') {
  Object.defineProperty(window, 'crypto', {
    value: { ...(window.crypto || {}), randomUUID },
    configurable: true,
  });
}

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function cloudData(content) {
  return {
    rawJson: '{"prompts":[]}',
    originalFilename: 'cloud.json',
    prompts: {
      a: { id: 'a', identifier: 'a', name: 'Alpha', content, enabled: true },
    },
    promptOrder: ['a'],
  };
}

let preset;
let sync;
let cloudSync;
// The mock server: GET returns `cloudDoc`; PUT applies the Worker's
// conditional-write rule and records every body in `puts`.
let cloudDoc;
let puts;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  setActivePinia(createPinia());

  cloudDoc = null;
  puts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts = {}) => {
      if ((opts.method || 'GET') === 'GET') {
        return jsonRes(cloudDoc || { updatedAt: null, data: null });
      }
      const body = JSON.parse(opts.body);
      puts.push(body);
      if (
        'baseUpdatedAt' in body &&
        cloudDoc &&
        cloudDoc.updatedAt &&
        body.baseUpdatedAt !== cloudDoc.updatedAt
      ) {
        return jsonRes({ error: 'conflict', updatedAt: cloudDoc.updatedAt }, 409);
      }
      cloudDoc = { updatedAt: body.updatedAt, data: body.data };
      return jsonRes({ ok: true, updatedAt: body.updatedAt });
    }),
  );

  cloudSync = await import('../src/stores/cloudSync.js');
  const { usePresetStore } = await import('../src/stores/presetStore.js');
  const { useSyncStore } = await import('../src/stores/syncStore.js');
  preset = usePresetStore();
  sync = useSyncStore();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Boot with a cloud doc at T1 and let the client adopt it. */
async function initAdopted() {
  cloudDoc = { updatedAt: 'T1', data: cloudData('v1') };
  await cloudSync.initCloudSync();
  expect(sync.cloudEnabled).toBe(true);
  expect(sync.lastSyncedAt).toBe('T1');
  expect(preset.prompts.a.content).toBe('v1');
}

/** Simulate another device pushing v2, and a local un-pushed edit. */
function diverge() {
  cloudDoc = { updatedAt: 'T2', data: cloudData('v2') };
  preset.prompts.a.content = 'local-edit';
  sync.set({ pendingSync: true });
}

describe('F2 automatic pull', () => {
  it('adopts a newer cloud copy silently when there are no local edits', async () => {
    await initAdopted();
    cloudDoc = { updatedAt: 'T2', data: cloudData('v2') };
    await cloudSync.pollCloudNow();
    expect(preset.prompts.a.content).toBe('v2');
    expect(sync.lastSyncedAt).toBe('T2');
    expect(sync.status).toBe('synced');
    expect(preset.confirmState.open).toBe(false);
  });

  it('does nothing when the cloud is unchanged', async () => {
    await initAdopted();
    await cloudSync.pollCloudNow();
    expect(sync.lastSyncedAt).toBe('T1');
    expect(puts).toHaveLength(0);
  });
});

describe('F2 conflict flow', () => {
  it('keep mine → force PUT without baseUpdatedAt', async () => {
    await initAdopted();
    diverge();

    await cloudSync.pollCloudNow();
    expect(preset.confirmState.open).toBe(true);
    expect(sync.status).toBe('conflict');

    preset.resolveConfirm(); // "Keep this device's version"
    await vi.waitFor(() => expect(sync.status).toBe('synced'));

    const lastPut = puts[puts.length - 1];
    expect('baseUpdatedAt' in lastPut).toBe(false);
    expect(cloudDoc.data.prompts.a.content).toBe('local-edit');
    expect(sync.pendingSync).toBe(false);
    expect(sync.lastSyncedAt).toBe(cloudDoc.updatedAt);
  });

  it('use cloud → adopts the cloud copy and discards the local push', async () => {
    await initAdopted();
    diverge();

    await cloudSync.pollCloudNow();
    expect(preset.confirmState.open).toBe(true);

    preset.cancelConfirm(); // "Use cloud version"
    await vi.waitFor(() => expect(sync.status).toBe('synced'));

    expect(preset.prompts.a.content).toBe('v2');
    expect(sync.lastSyncedAt).toBe('T2');
    expect(sync.pendingSync).toBe(false);
    expect(puts).toHaveLength(0); // nothing was pushed
    expect(cloudDoc.data.prompts.a.content).toBe('v2'); // cloud untouched
  });

  it('dismiss defers: nothing is lost and the poll stops nagging', async () => {
    await initAdopted();
    diverge();

    await cloudSync.pollCloudNow();
    expect(preset.confirmState.open).toBe(true);

    preset.dismissConfirm(); // Esc / backdrop — "not now"
    expect(preset.prompts.a.content).toBe('local-edit'); // local kept
    expect(sync.status).toBe('conflict');
    expect(sync.pendingSync).toBe(true);

    await cloudSync.pollCloudNow(); // 30s tick — must not re-prompt
    expect(preset.confirmState.open).toBe(false);
    expect(preset.prompts.a.content).toBe('local-edit');
  });

  it('after a dismissal, the next edit-triggered push re-opens the dialog', async () => {
    await initAdopted();
    diverge();
    await cloudSync.pollCloudNow();
    preset.dismissConfirm();

    // A real edit → subscription → debounced push → 409 → dialog again.
    preset.updatePromptDetail({ promptId: 'a', field: 'content', value: 'local-edit-2' });
    await Promise.resolve(); // let the (pre-flush) subscription run
    vi.advanceTimersByTime(1600); // fire the debounced push
    await vi.waitFor(() => expect(preset.confirmState.open).toBe(true));
    expect(sync.status).toBe('conflict');
  });
});

describe('sign-in reconcile: local edits are not silently discarded', () => {
  it('asks which to keep when the device has un-synced edits that differ from the cloud', async () => {
    // Simulate editing while signed OUT: local data + undo history, but nothing
    // flagged pendingSync (sync was off). Then "sign in" to a non-empty cloud.
    preset.prompts = {
      a: { id: 'a', identifier: 'a', name: 'Alpha', content: 'mine', enabled: true },
    };
    preset.promptOrder = ['a'];
    preset.clearHistory();
    preset.updatePromptDetail({ promptId: 'a', field: 'content', value: 'local-unsynced' });
    expect(preset.canUndo).toBe(true);
    expect(sync.pendingSync).toBe(false);

    cloudDoc = { updatedAt: 'T1', data: cloudData('cloud-v1') };
    await cloudSync.initCloudSync();

    // The user is asked; nothing was silently overwritten or blindly pushed.
    expect(preset.confirmState.open).toBe(true);
    expect(sync.status).toBe('conflict');
    expect(preset.prompts.a.content).toBe('local-unsynced');
    expect(puts).toHaveLength(0);
  });

  it('adopts the cloud silently on a fresh, unedited device (no nag)', async () => {
    // No local edits (canUndo === false) → normal sign-in must not prompt.
    expect(preset.canUndo).toBe(false);
    cloudDoc = { updatedAt: 'T1', data: cloudData('cloud-v1') };
    await cloudSync.initCloudSync();

    expect(preset.confirmState.open).toBe(false);
    expect(preset.prompts.a.content).toBe('cloud-v1');
    expect(sync.status).toBe('synced');
    expect(sync.lastSyncedAt).toBe('T1');
  });
});
