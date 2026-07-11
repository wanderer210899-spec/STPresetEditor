// Phase 2 (F2) — Worker conditional PUT conflict matrix.
//
// The auth layer is mocked to a fixed identity; these tests exercise only the
// /api/presets document semantics: blind writes stay backward compatible,
// conditional writes (baseUpdatedAt) 409 instead of clobbering.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../worker/auth.js', () => ({
  handleAuth: async () => null,
  identify: async () => 'user:test',
}));

import worker from '../worker/index.js';

function makeKV(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: async (k) => (map.has(k) ? map.get(k) : null),
    put: async (k, v) => {
      map.set(k, v);
    },
    _map: map,
  };
}

const URL_ = 'https://example.test/api/presets';

async function putDoc(env, body) {
  return worker.fetch(new Request(URL_, { method: 'PUT', body: JSON.stringify(body) }), env);
}

let env;

beforeEach(() => {
  env = { PRESETS: makeKV() };
});

describe('worker PUT /api/presets', () => {
  it('blind write (no baseUpdatedAt) overwrites — backward compatible', async () => {
    await putDoc(env, { updatedAt: 'T1', data: { a: 1 } });
    const res = await putDoc(env, { updatedAt: 'T2', data: { a: 2 } });
    expect(res.status).toBe(200);
    expect(JSON.parse(env.PRESETS._map.get('user:test'))).toEqual({
      updatedAt: 'T2',
      data: { a: 2 },
    });
  });

  it('conditional write with a matching base succeeds', async () => {
    await putDoc(env, { updatedAt: 'T1', data: { a: 1 } });
    const res = await putDoc(env, { updatedAt: 'T2', data: { a: 2 }, baseUpdatedAt: 'T1' });
    expect(res.status).toBe(200);
    expect(JSON.parse(env.PRESETS._map.get('user:test')).updatedAt).toBe('T2');
  });

  it('conditional write with a stale base returns 409 and leaves the doc intact', async () => {
    await putDoc(env, { updatedAt: 'T2', data: { a: 'newer' } });
    const res = await putDoc(env, { updatedAt: 'T3', data: { a: 'stale' }, baseUpdatedAt: 'T1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict', updatedAt: 'T2' });
    expect(JSON.parse(env.PRESETS._map.get('user:test')).data).toEqual({ a: 'newer' });
  });

  it('conditional write against an empty cloud succeeds (first seed)', async () => {
    const res = await putDoc(env, { updatedAt: 'T1', data: { a: 1 }, baseUpdatedAt: null });
    expect(res.status).toBe(200);
  });

  it('a never-synced client (base null) conflicts with an existing doc', async () => {
    await putDoc(env, { updatedAt: 'T1', data: { a: 1 } });
    const res = await putDoc(env, { updatedAt: 'T2', data: { a: 2 }, baseUpdatedAt: null });
    expect(res.status).toBe(409);
  });

  it('stores the normalised document only (baseUpdatedAt is not persisted)', async () => {
    await putDoc(env, { updatedAt: 'T1', data: { a: 1 }, baseUpdatedAt: null });
    const stored = JSON.parse(env.PRESETS._map.get('user:test'));
    expect(stored).toEqual({ updatedAt: 'T1', data: { a: 1 } });
    expect('baseUpdatedAt' in stored).toBe(false);
  });

  it('GET returns the stored document', async () => {
    await putDoc(env, { updatedAt: 'T1', data: { a: 1 } });
    const res = await worker.fetch(new Request(URL_), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updatedAt: 'T1', data: { a: 1 } });
  });
});
