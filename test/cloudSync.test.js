// Web cloud client — "storage + explicit save" model. The cloud is name-keyed
// storage; the web app keeps its auto-save UX via a per-entry diff push. These
// tests run against an in-memory fetch mock that mirrors the Worker's
// name-keyed routes, and cover the acceptance checklist's web-side behaviour:
// adopt on load, upload new names, newest-wins, deletes stick (no
// resurrection), renames move the record, and same-name writes never duplicate.

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

/** A cloud record in the worker's stored shape. */
function record(name, content, updatedAt) {
  return {
    name,
    updatedAt,
    data: {
      rawJson: '{"prompts":[]}',
      originalFilename: `${name}.json`,
      prompts: { a: { id: 'a', identifier: 'a', name: 'Alpha', content, enabled: true } },
      promptOrder: ['a'],
    },
    snapshots: [],
  };
}

let preset;
let sync;
let cloudSync;
// The mock server: `cloud` maps name -> record; `signedOut` makes every route 401.
let cloud;
let signedOut;
let requests; // [{ method, name, snapshot }]

function installFetchMock() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts = {}) => {
      if (signedOut) return jsonRes({ error: 'unauthenticated' }, 401);
      const parsed = new URL(url, 'https://app.test');
      const method = opts.method || 'GET';
      const rest = parsed.pathname.slice('/api/presets'.length);
      const name = rest.startsWith('/') ? decodeURIComponent(rest.slice(1)) : null;
      requests.push({ method, name, snapshot: parsed.searchParams.get('snapshot') === '1' });

      if (name === null) {
        return jsonRes({
          presets: Array.from(cloud.values())
            .map((r) => ({ name: r.name, updatedAt: r.updatedAt }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        });
      }
      if (method === 'GET') {
        return cloud.has(name) ? jsonRes(cloud.get(name)) : jsonRes({ error: 'not_found' }, 404);
      }
      if (method === 'PUT') {
        const body = JSON.parse(opts.body);
        const existing = cloud.get(name);
        const updatedAt = body.updatedAt || new Date().toISOString();
        let snapshots = Array.isArray(body.snapshots) ? body.snapshots : existing?.snapshots || [];
        if (
          parsed.searchParams.get('snapshot') === '1' &&
          existing &&
          JSON.stringify(existing.data) !== JSON.stringify(body.data)
        ) {
          snapshots = [
            { id: 's', createdAt: existing.updatedAt, data: existing.data },
            ...snapshots,
          ];
        }
        cloud.set(name, { name, updatedAt, data: body.data, snapshots });
        return jsonRes({ ok: true, updatedAt, existed: Boolean(existing) });
      }
      if (method === 'DELETE') {
        cloud.delete(name);
        return jsonRes({ ok: true });
      }
      return jsonRes({ error: 'method_not_allowed' }, 405);
    }),
  );
}

/** Fresh app boot (fresh modules + stores); localStorage — and with it the
 *  persisted pushed-map — carries over unless a test clears it. */
async function bootApp() {
  vi.resetModules();
  setActivePinia(createPinia());
  cloudSync = await import('../src/stores/cloudSync.js');
  const { usePresetStore } = await import('../src/stores/presetStore.js');
  const { useSyncStore } = await import('../src/stores/syncStore.js');
  preset = usePresetStore();
  sync = useSyncStore();
}

beforeEach(async () => {
  vi.useFakeTimers();
  cloud = new Map();
  signedOut = false;
  requests = [];
  window.localStorage.clear(); // the pushed map must not leak between tests
  installFetchMock();
  await bootApp();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const putsFor = (name) => requests.filter((r) => r.method === 'PUT' && r.name === name);
const localNames = () => Object.values(preset.savedPresets).map((e) => e.name);

describe('startup reconcile', () => {
  it('adopts the cloud library into the local list (no pushes, no dialogs)', async () => {
    cloud.set('One', record('One', 'v1', 'T1'));
    cloud.set('Two', record('Two', 'v2', 'T2'));
    await cloudSync.initCloudSync();

    expect(sync.cloudEnabled).toBe(true);
    expect(sync.status).toBe('synced');
    expect(localNames().sort()).toEqual(['One', 'Two']);
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
    expect(preset.confirmState.open).toBe(false); // no conflict dialogs exist anymore
  });

  it('uploads a local preset the cloud has never seen', async () => {
    preset.savedPresets.id1 = {
      name: 'Mine',
      data: record('Mine', 'local', '').data,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    await cloudSync.initCloudSync();

    expect(cloud.has('Mine')).toBe(true);
    expect(cloud.size).toBe(1);
    expect(sync.status).toBe('synced');
  });

  it('a preset deleted in the cloud stays deleted — never resurrected', async () => {
    cloud.set('Doomed', record('Doomed', 'v1', 'T1'));
    await cloudSync.initCloudSync();
    expect(localNames()).toContain('Doomed');

    // Another device deletes it; this device restarts with its stale local copy.
    cloud.delete('Doomed');
    await bootApp();
    preset.savedPresets.stale = {
      name: 'Doomed',
      data: record('Doomed', 'v1', 'T1').data,
      createdAt: 'T1',
      updatedAt: 'T1',
    };
    requests = [];
    await cloudSync.initCloudSync();

    expect(localNames()).not.toContain('Doomed'); // removed locally
    expect(cloud.has('Doomed')).toBe(false); // and NOT pushed back
    expect(putsFor('Doomed')).toHaveLength(0);
  });

  it('newest wins when both sides changed the same name', async () => {
    cloud.set('P', record('P', 'v1', '2026-07-01T00:00:00.000Z'));
    await cloudSync.initCloudSync();

    // Cloud moves ahead…
    cloud.set('P', record('P', 'cloud-newer', '2026-07-10T00:00:00.000Z'));
    // …and local moved too, but EARLIER.
    await bootApp();
    preset.savedPresets.p = {
      name: 'P',
      data: record('P', 'local-older', '').data,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-05T00:00:00.000Z',
    };
    await cloudSync.initCloudSync();
    expect(preset.savedPresets.p.data.prompts.a.content).toBe('cloud-newer');

    // The reverse: local newer than cloud → local wins (pushed up).
    cloud.set('Q', record('Q', 'cloud-older', '2026-07-02T00:00:00.000Z'));
    await bootApp();
    window.localStorage.clear();
    preset.savedPresets.q = {
      name: 'Q',
      data: record('Q', 'local-newer', '').data,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-09T00:00:00.000Z',
    };
    await cloudSync.initCloudSync();
    expect(cloud.get('Q').data.prompts.a.content).toBe('local-newer');
  });

  it('stays local-only when signed out (401)', async () => {
    signedOut = true;
    preset.savedPresets.id1 = {
      name: 'Mine',
      data: record('Mine', 'local', '').data,
      updatedAt: 'T1',
    };
    await cloudSync.initCloudSync();
    expect(sync.cloudEnabled).toBe(false);
    expect(cloud.size).toBe(0);
    expect(localNames()).toContain('Mine'); // nothing was touched
  });
});

describe('web auto-save (the diff push)', () => {
  it('edits to the open preset upload under its NAME — one record, no duplicates', async () => {
    await cloudSync.initCloudSync();

    // Open a document and let autosave adopt it into the library.
    preset.rawJson = '{"prompts":[]}';
    preset.originalFilename = 'My Preset.json';
    preset.prompts = {
      a: { id: 'a', identifier: 'a', name: 'Alpha', content: 'first', enabled: true },
    };
    preset.promptOrder = ['a'];
    preset.saveActivePreset();
    await vi.advanceTimersByTimeAsync(6000);
    expect(cloud.has('My Preset')).toBe(true);
    expect(cloud.size).toBe(1);

    // Keep editing — the same record is replaced, never a second one.
    preset.updatePromptDetail({ promptId: 'a', field: 'content', value: 'second' });
    await vi.advanceTimersByTimeAsync(6000);
    expect(cloud.size).toBe(1);
    expect(cloud.get('My Preset').data.prompts.a.content).toBe('second');
  });

  it('deleting a preset deletes its cloud record', async () => {
    cloud.set('Gone', record('Gone', 'v1', 'T1'));
    await cloudSync.initCloudSync();
    const id = Object.keys(preset.savedPresets).find((k) => preset.savedPresets[k].name === 'Gone');
    preset.deletePreset(id);
    await vi.advanceTimersByTimeAsync(6000);
    expect(cloud.has('Gone')).toBe(false);
  });

  it('renaming a preset moves the record (new name written, old name deleted)', async () => {
    cloud.set('Old', record('Old', 'v1', 'T1'));
    await cloudSync.initCloudSync();
    const id = Object.keys(preset.savedPresets).find((k) => preset.savedPresets[k].name === 'Old');
    preset.updatePreset(id, 'New');
    await vi.advanceTimersByTimeAsync(6000);
    expect(cloud.has('New')).toBe(true);
    expect(cloud.has('Old')).toBe(false);
    expect(cloud.size).toBe(1);
  });

  it('snapshot changes sync too (they do not bump updatedAt)', async () => {
    cloud.set('P', record('P', 'v1', 'T1'));
    await cloudSync.initCloudSync();
    const id = Object.keys(preset.savedPresets).find((k) => preset.savedPresets[k].name === 'P');
    preset.createSnapshot(id, 'before big edit');
    await vi.advanceTimersByTimeAsync(6000);
    expect(cloud.get('P').snapshots.some((s) => s.name === 'before big edit')).toBe(true);
  });
});

describe('explicit refresh', () => {
  it('picks up presets another device added, without pushing anything', async () => {
    await cloudSync.initCloudSync();
    cloud.set('FromCursor', record('FromCursor', 'sent', 'T5'));
    requests = [];
    const ok = await cloudSync.refreshCloudLibrary();
    expect(ok).toBe(true);
    expect(localNames()).toContain('FromCursor');
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
  });
});
