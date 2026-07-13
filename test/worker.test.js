// Worker /api/presets — name-keyed storage semantics ("storage + explicit save").
//
// The auth layer is mocked to a fixed identity; these tests exercise the
// per-preset routes: index listing, single-preset GET/PUT/DELETE, the
// name-identity rule (same name = replace, never a second record), and the
// `?snapshot=1` keep-previous-version behaviour of the explicit send.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../worker/auth.js', () => ({
  handleAuth: async () => null,
  identify: async () => 'user:test',
}));

import worker from '../worker/index.js';

/** In-memory KV with list({prefix}) + metadata, mirroring Cloudflare KV. */
function makeKV(initial = {}) {
  const map = new Map(Object.entries(initial));
  const meta = new Map();
  return {
    get: async (k) => (map.has(k) ? map.get(k) : null),
    put: async (k, v, opts = {}) => {
      map.set(k, v);
      meta.set(k, opts.metadata || null);
    },
    delete: async (k) => {
      map.delete(k);
      meta.delete(k);
    },
    list: async ({ prefix = '' } = {}) => ({
      keys: Array.from(map.keys())
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name, metadata: meta.get(name) || null })),
      list_complete: true,
    }),
    _map: map,
  };
}

const BASE = 'https://example.test/api/presets';
const KEY = (name) => `user:test:p:${name}`;

async function put(env, name, body, { snapshot = false } = {}) {
  const url = `${BASE}/${encodeURIComponent(name)}${snapshot ? '?snapshot=1' : ''}`;
  return worker.fetch(new Request(url, { method: 'PUT', body: JSON.stringify(body) }), env);
}

async function getOne(env, name) {
  return worker.fetch(new Request(`${BASE}/${encodeURIComponent(name)}`), env);
}

async function del(env, name) {
  return worker.fetch(
    new Request(`${BASE}/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    env,
  );
}

async function index(env) {
  const res = await worker.fetch(new Request(BASE), env);
  return { status: res.status, body: await res.json() };
}

let env;

beforeEach(() => {
  env = { PRESETS: makeKV() };
});

describe('PUT /api/presets/:name — name identity', () => {
  it('creates exactly one record for a new name', async () => {
    const res = await put(env, 'My Preset', { data: { a: 1 }, updatedAt: 'T1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updatedAt: 'T1', existed: false });
    const stored = JSON.parse(env.PRESETS._map.get(KEY('My Preset')));
    expect(stored).toEqual({ name: 'My Preset', updatedAt: 'T1', data: { a: 1 }, snapshots: [] });
    expect(env.PRESETS._map.size).toBe(1);
  });

  it('same name replaces the record — newest wins, never a duplicate', async () => {
    await put(env, 'My Preset', { data: { v: 'old' }, updatedAt: 'T1' });
    const res = await put(env, 'My Preset', { data: { v: 'new' }, updatedAt: 'T2' });
    expect((await res.json()).existed).toBe(true);
    expect(env.PRESETS._map.size).toBe(1); // ONE record with that name
    const stored = JSON.parse(env.PRESETS._map.get(KEY('My Preset')));
    expect(stored.data).toEqual({ v: 'new' });
  });

  it('?snapshot=1 keeps the replaced version as a restorable snapshot', async () => {
    await put(env, 'P', { data: { v: 'old' }, updatedAt: 'T1' });
    await put(env, 'P', { data: { v: 'new' }, updatedAt: 'T2' }, { snapshot: true });
    const stored = JSON.parse(env.PRESETS._map.get(KEY('P')));
    expect(stored.data).toEqual({ v: 'new' });
    expect(stored.snapshots).toHaveLength(1);
    expect(stored.snapshots[0].data).toEqual({ v: 'old' });
    expect(stored.snapshots[0].createdAt).toBe('T1');
    expect(stored.snapshots[0].id).toBeTruthy();
  });

  it('?snapshot=1 does not snapshot an identical send (no churn)', async () => {
    await put(env, 'P', { data: { v: 'same' }, updatedAt: 'T1' });
    await put(env, 'P', { data: { v: 'same' }, updatedAt: 'T2' }, { snapshot: true });
    const stored = JSON.parse(env.PRESETS._map.get(KEY('P')));
    expect(stored.snapshots).toHaveLength(0);
  });

  it('a plain PUT (web auto-save) keeps existing cloud snapshots', async () => {
    await put(env, 'P', { data: { v: 1 }, updatedAt: 'T1' });
    await put(env, 'P', { data: { v: 2 }, updatedAt: 'T2' }, { snapshot: true });
    await put(env, 'P', { data: { v: 3 }, updatedAt: 'T3' }); // no snapshots key in body
    const stored = JSON.parse(env.PRESETS._map.get(KEY('P')));
    expect(stored.data).toEqual({ v: 3 });
    expect(stored.snapshots).toHaveLength(1); // the T1 snapshot survived
  });

  it('a client-sent snapshots array replaces the stored list (web library sync)', async () => {
    await put(env, 'P', { data: { v: 1 }, updatedAt: 'T1' });
    const snaps = [{ id: 's1', name: 'named', createdAt: 'T0', data: { v: 0 } }];
    await put(env, 'P', { data: { v: 2 }, updatedAt: 'T2', snapshots: snaps });
    const stored = JSON.parse(env.PRESETS._map.get(KEY('P')));
    expect(stored.snapshots).toEqual(snaps);
  });

  it('caps stored snapshots at 20', async () => {
    const snaps = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, data: { i } }));
    await put(env, 'P', { data: { v: 1 }, updatedAt: 'T1', snapshots: snaps });
    const stored = JSON.parse(env.PRESETS._map.get(KEY('P')));
    expect(stored.snapshots).toHaveLength(20);
  });

  it('rejects a missing data field and malformed names', async () => {
    expect((await put(env, 'P', { updatedAt: 'T1' })).status).toBe(400);
    expect((await put(env, '   ', { data: {} })).status).toBe(400);
    expect((await put(env, 'x'.repeat(300), { data: {} })).status).toBe(400);
  });
});

describe('GET /api/presets — the index', () => {
  it('lists names + updatedAt from metadata, sorted', async () => {
    await put(env, 'Zeta', { data: {}, updatedAt: 'T2' });
    await put(env, 'Alpha', { data: {}, updatedAt: 'T1' });
    const { status, body } = await index(env);
    expect(status).toBe(200);
    expect(body.presets).toEqual([
      { name: 'Alpha', updatedAt: 'T1' },
      { name: 'Zeta', updatedAt: 'T2' },
    ]);
  });

  it('ignores the legacy whole-library blob key', async () => {
    // Pre-rewrite deployments stored one blob at the bare identity key.
    env.PRESETS._map.set('user:test', JSON.stringify({ updatedAt: 'T0', data: {} }));
    await put(env, 'P', { data: {}, updatedAt: 'T1' });
    const { body } = await index(env);
    expect(body.presets).toEqual([{ name: 'P', updatedAt: 'T1' }]);
  });

  it('rejects non-GET methods on the collection', async () => {
    const res = await worker.fetch(new Request(BASE, { method: 'PUT', body: '{}' }), env);
    expect(res.status).toBe(405);
  });
});

describe('GET/DELETE /api/presets/:name', () => {
  it('GET returns the stored record; 404 for a missing name', async () => {
    await put(env, 'P', { data: { v: 1 }, updatedAt: 'T1' });
    const res = await getOne(env, 'P');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'P', updatedAt: 'T1', data: { v: 1 }, snapshots: [] });
    expect((await getOne(env, 'Nope')).status).toBe(404);
  });

  it('DELETE removes the record and it stays gone', async () => {
    await put(env, 'P', { data: { v: 1 }, updatedAt: 'T1' });
    expect((await del(env, 'P')).status).toBe(200);
    expect((await getOne(env, 'P')).status).toBe(404);
    const { body } = await index(env);
    expect(body.presets).toEqual([]);
    expect((await del(env, 'P')).status).toBe(200); // idempotent
  });

  it('handles names with unicode and spaces via URL encoding', async () => {
    const name = '我的 预设 (v2)';
    await put(env, name, { data: { v: 1 }, updatedAt: 'T1' });
    const res = await getOne(env, name);
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe(name);
  });
});

describe('availability', () => {
  it('returns 503 when KV is not bound', async () => {
    const res = await worker.fetch(new Request(BASE), { PRESETS: undefined });
    expect(res.status).toBe(503);
  });
});
