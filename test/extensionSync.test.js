// VS Code extension — "storage + explicit save" acceptance tests, run against
// a scriptable host stand-in speaking the new explicit protocol. Its
// postMessage runs structuredClone(msg) — exactly like the real webview<->host
// boundary — so any non-cloneable payload (e.g. a Vue proxy) fails here just
// as it would live.
//
// Covered acceptance checks:
//   • Interface A (file editor): editing a local file NEVER creates or changes
//     a cloud preset on its own; "Send to cloud" with a new name creates
//     exactly ONE record; sending an existing name replaces it (newest wins)
//     and keeps the prior version as a snapshot — no duplicate.
//   • Interface B (cloud browser): the list mirrors the cloud; edits stay
//     local until an explicit send; deleting a preset deletes the cloud
//     record and it does NOT come back; the Save button routes to a workspace
//     folder pick.

import { randomUUID } from 'node:crypto';
import { setActivePinia, createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

if (typeof window.crypto?.randomUUID !== 'function') {
  Object.defineProperty(window, 'crypto', {
    value: { ...(window.crypto || {}), randomUUID },
    configurable: true,
  });
}

let host;
function dispatch(data) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function makeHost() {
  return {
    cloud: new Map(), // name -> { name, updatedAt, data, snapshots }
    connected: true,
    sent: [], // every cloudSend message
    deleted: [], // every cloudDelete message
    saves: [], // every file-mirror 'save' message
    workspaceSaves: [], // every saveToWorkspace message
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
          dispatch({ type: 'cloudState', url: 'https://w', connected: this.connected, email: 'e' });
          break;
        case 'cloudList':
          if (!this.connected) return dispatch({ type: 'cloudListResult', connected: false });
          dispatch({
            type: 'cloudListResult',
            connected: true,
            presets: Array.from(this.cloud.values()).map((r) => ({
              name: r.name,
              updatedAt: r.updatedAt,
            })),
          });
          break;
        case 'cloudLoad': {
          const r = this.cloud.get(m.name);
          dispatch({ type: 'cloudLoaded', ok: Boolean(r), entry: r || null });
          break;
        }
        case 'cloudSend': {
          this.sent.push(m);
          const existing = this.cloud.get(m.name);
          const updatedAt = m.updatedAt || new Date().toISOString();
          let snapshots = Array.isArray(m.snapshots) ? m.snapshots : existing?.snapshots || [];
          if (m.snapshot && existing && JSON.stringify(existing.data) !== JSON.stringify(m.data)) {
            snapshots = [
              { id: `s${snapshots.length}`, createdAt: existing.updatedAt, data: existing.data },
              ...snapshots,
            ];
          }
          this.cloud.set(m.name, { name: m.name, updatedAt, data: m.data, snapshots });
          dispatch({ type: 'cloudSent', ok: true, updatedAt, existed: Boolean(existing) });
          break;
        }
        case 'cloudDelete':
          this.deleted.push(m);
          this.cloud.delete(m.name);
          dispatch({ type: 'cloudDeleted', ok: true });
          break;
        case 'cloudRename': {
          const r = this.cloud.get(m.oldName);
          if (r) {
            this.cloud.set(m.newName, { ...r, name: m.newName });
            this.cloud.delete(m.oldName);
          }
          dispatch({ type: 'cloudRenamed', ok: true, updatedAt: r ? r.updatedAt : null });
          break;
        }
        case 'saveToWorkspace':
          this.workspaceSaves.push(m);
          dispatch({ type: 'workspaceSaved', ok: true, path: `/ws/${m.name}`, fileName: m.name });
          break;
        case 'save':
          this.saves.push(m);
          break;
        default:
          break; // ignore ready/cloudConnect/…
      }
    },
  };
}

let bridge;
let cloudSync;
let preset;
let sync;

function cloudRecord(name, content, updatedAt) {
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

const FILE_JSON = JSON.stringify({
  prompts: [{ identifier: 'main', name: 'Main', content: 'from disk', enabled: true }],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
});

async function boot(mode) {
  vi.resetModules();
  window.__STPE_MODE__ = mode;
  host = makeHost();
  window.acquireVsCodeApi = () => host.api;
  window.localStorage.clear();
  setActivePinia(createPinia());

  bridge = await import('../src/stores/localBridge.js');
  cloudSync = await import('../src/stores/cloudSync.js');
  const presetMod = await import('../src/stores/presetStore.js');
  const syncMod = await import('../src/stores/syncStore.js');
  preset = presetMod.usePresetStore();
  sync = syncMod.useSyncStore();
  await bridge.initLocalBridge();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** Let queued microtask replies (the host mock) and debounces settle. */
async function settle(ms = 8000) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('Interface A — the file editor', () => {
  it('opening and editing a local file never touches the cloud', async () => {
    await boot('file');
    dispatch({
      type: 'load',
      path: '/tmp/My Preset.json',
      name: 'My Preset.json',
      json: FILE_JSON,
    });
    await settle();
    expect(preset.prompts.main.content).toBe('from disk');

    preset.updatePromptDetail({ promptId: 'main', field: 'content', value: 'edited locally' });
    await settle();

    expect(host.saves.length).toBeGreaterThan(0); // mirrored to disk…
    expect(host.saves[host.saves.length - 1].json).toContain('edited locally');
    expect(host.sent).toHaveLength(0); // …but NEVER sent to the cloud
    expect(host.cloud.size).toBe(0);
  });

  it('"Send to cloud" with a NEW name creates exactly one cloud preset', async () => {
    await boot('file');
    dispatch({
      type: 'load',
      path: '/tmp/My Preset.json',
      name: 'My Preset.json',
      json: FILE_JSON,
    });
    await settle();

    const resPromise = cloudSync.sendActivePresetToCloud();
    await settle();
    const res = await resPromise;

    expect(res.ok).toBe(true);
    expect(res.existed).toBe(false);
    expect(res.name).toBe('My Preset'); // the FILE's name is the identity
    expect(host.cloud.size).toBe(1);
    expect(host.sent[0].snapshot).toBe(true); // explicit send always keeps history
  });

  it('sending an EXISTING name replaces it (newest wins) and keeps a snapshot — no duplicate', async () => {
    await boot('file');
    host.cloud.set('My Preset', cloudRecord('My Preset', 'older cloud version', 'T1'));
    dispatch({
      type: 'load',
      path: '/tmp/My Preset.json',
      name: 'My Preset.json',
      json: FILE_JSON,
    });
    await settle();

    const resPromise = cloudSync.sendActivePresetToCloud();
    await settle();
    const res = await resPromise;

    expect(res.ok).toBe(true);
    expect(res.existed).toBe(true);
    expect(host.cloud.size).toBe(1); // still exactly ONE preset with that name
    const stored = host.cloud.get('My Preset');
    expect(stored.data.prompts.main.content).toBe('from disk'); // sent version won
    expect(stored.snapshots).toHaveLength(1); // prior version restorable
    expect(stored.snapshots[0].data.prompts.a.content).toBe('older cloud version');
  });
});

describe('Interface B — the cloud browser', () => {
  it('mirrors the cloud list on init; edits stay local until an explicit send', async () => {
    await boot('library');
    host.cloud.set('One', cloudRecord('One', 'v1', 'T1'));
    await cloudSync.initCloudSync();
    await settle();

    const names = Object.values(preset.savedPresets).map((e) => e.name);
    expect(names).toContain('One');
    expect(sync.cloudEnabled).toBe(true);

    // Open it and edit — nothing may reach the cloud by itself.
    const id = Object.keys(preset.savedPresets).find((k) => preset.savedPresets[k].name === 'One');
    preset.loadPreset(id);
    preset.updatePromptDetail({ promptId: 'a', field: 'content', value: 'unsent edit' });
    await settle();
    expect(host.sent).toHaveLength(0);
    expect(host.cloud.get('One').data.prompts.a.content).toBe('v1');

    // The explicit send uploads it (structured-clone-safe payload included).
    const resPromise = cloudSync.sendActivePresetToCloud();
    await settle();
    const res = await resPromise;
    expect(res.ok).toBe(true);
    expect(host.cloud.get('One').data.prompts.a.content).toBe('unsent edit');
    expect(host.cloud.size).toBe(1);
  });

  it('deleting a preset deletes the cloud record and it does NOT come back', async () => {
    await boot('library');
    host.cloud.set('Doomed', cloudRecord('Doomed', 'v1', 'T1'));
    await cloudSync.initCloudSync();
    await settle();

    const id = Object.keys(preset.savedPresets).find(
      (k) => preset.savedPresets[k].name === 'Doomed',
    );
    preset.deletePreset(id); // the manager's explicit delete
    await settle();

    expect(host.deleted.map((m) => m.name)).toContain('Doomed');
    expect(host.cloud.has('Doomed')).toBe(false);

    // An explicit refresh must not resurrect it.
    await cloudSync.refreshCloudLibrary();
    await settle();
    expect(Object.values(preset.savedPresets).map((e) => e.name)).not.toContain('Doomed');
    expect(host.cloud.has('Doomed')).toBe(false);
  });

  it('renaming a preset renames the cloud record (name = identity)', async () => {
    await boot('library');
    host.cloud.set('Old', cloudRecord('Old', 'v1', 'T1'));
    await cloudSync.initCloudSync();
    await settle();

    const id = Object.keys(preset.savedPresets).find((k) => preset.savedPresets[k].name === 'Old');
    preset.updatePreset(id, 'New');
    await settle();

    expect(host.cloud.has('New')).toBe(true);
    expect(host.cloud.has('Old')).toBe(false);
  });

  it('the Save button writes into a picked workspace folder (host-side overwrite)', async () => {
    await boot('library');
    host.cloud.set('One', cloudRecord('One', 'v1', 'T1'));
    await cloudSync.initCloudSync();
    await settle();
    const id = Object.keys(preset.savedPresets).find((k) => preset.savedPresets[k].name === 'One');
    preset.loadPreset(id);

    const resPromise = bridge.saveActiveToWorkspace();
    await settle();
    const res = await resPromise;

    expect(res.ok).toBe(true);
    expect(res.fileName).toBe('One.json');
    expect(host.workspaceSaves).toHaveLength(1);
    expect(host.workspaceSaves[0].json).toContain('"prompts"');
  });

  it('stays local-only (no throw) when the host is not connected', async () => {
    await boot('library');
    host.connected = false;
    await cloudSync.initCloudSync();
    await settle();
    expect(sync.cloudEnabled).toBe(false);
    expect(host.sent).toHaveLength(0);
  });
});
