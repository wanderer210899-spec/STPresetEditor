// Cloudflare Worker entry point.
//
// One Worker serves both the built single-page app (via the ASSETS binding) and
// the cloud-storage + auth API. Built to be self-hosted: anyone can deploy their
// own private, single-user instance.
//
// STORAGE MODEL (2026-07: "storage + explicit save")
//   The cloud is passive, NAMED storage: one KV record per preset, keyed by the
//   preset's NAME. There is never more than one cloud preset with the same name
//   — writing an existing name replaces it (newest wins) and, when the client
//   asks (`?snapshot=1`, the explicit "Send to cloud" action), the previous
//   version is kept as a restorable snapshot inside the record. No documents
//   are merged and there is no conflict protocol: clients read the index, read
//   one preset, write one preset, or delete one preset.
//
// AUTH MODEL (see worker/auth.js)
//   One deployment = one owner. The owner signs in with email + password
//   (sessions in D1); the VS Code extension / any client authenticates with a
//   generated API key (`X-API-Key`). Identity → KV key prefix, so the library is
//   isolated to the owner. With no verified identity we FAIL CLOSED (401) and
//   the app runs local-only. There are NO secrets in this file or the repo.

import { handleAuth, identify } from './auth.js';

/** Per-preset snapshot cap — matches the app's MAX_SNAPSHOTS_PER_PRESET. */
const MAX_SNAPSHOTS = 20;
/** KV keys are capped at 512 bytes; leave generous room for the identity prefix. */
const MAX_NAME_LENGTH = 200;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders },
  });
}

/**
 * CORS for `/api/*`. The web app is same-origin (no CORS needed) and the
 * extension host calls from Node (CORS is a browser concept), so cross-origin
 * browser access is OFF by default. Credentialed CORS is dangerous to hand out
 * broadly: with SameSite=Lax the session cookie still rides along, so echoing an
 * arbitrary Origin + `Allow-Credentials: true` would let any origin (e.g. a
 * sibling subdomain on a custom domain) read `/api/presets` and mint/read API
 * keys via `/api/keys`. So we grant it ONLY to origins explicitly allowlisted in
 * the `ALLOWED_ORIGINS` Worker var (comma-separated). No allowlist ⇒ no
 * cross-origin access (fail closed).
 */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization, x-api-key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function withCors(response, cors) {
  for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
  return response;
}

/** KV key prefix for one owner's presets. The bare identity string was the
 *  legacy whole-library blob key; the `:p:` segment keeps the two disjoint. */
function presetPrefix(identity) {
  return `${identity}:p:`;
}

/**
 * Preset name from `/api/presets/<encoded name>`, or null for the collection
 * route. Returns `{ error }` for a malformed name so callers can 400.
 */
function presetNameFromPath(pathname) {
  const rest = pathname.slice('/api/presets'.length);
  if (rest === '' || rest === '/') return { name: null };
  let name;
  try {
    name = decodeURIComponent(rest.slice(1));
  } catch {
    return { error: 'invalid_name' };
  }
  name = name.trim();
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f]/.test(name)) {
    return { error: 'invalid_name' };
  }
  return { name };
}

/** Human-readable label for a worker-kept snapshot ("Cloud version 2026-07-13 09:15"). */
function snapshotLabel(updatedAt) {
  const stamp =
    typeof updatedAt === 'string' && updatedAt ? updatedAt.slice(0, 16).replace('T', ' ') : '';
  return stamp ? `Cloud version ${stamp}` : 'Cloud version';
}

/** GET /api/presets — the index: every preset's name + updatedAt (from KV
 *  metadata, so listing never reads the blobs). */
async function listPresets(env, identity) {
  const prefix = presetPrefix(identity);
  const presets = [];
  let cursor;
  do {
    const page = await env.PRESETS.list({ prefix, cursor });
    for (const key of page.keys || []) {
      presets.push({
        name: key.name.slice(prefix.length),
        updatedAt: (key.metadata && key.metadata.updatedAt) || null,
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  presets.sort((a, b) => a.name.localeCompare(b.name));
  return json({ presets });
}

/**
 * PUT /api/presets/:name — create or replace ONE named preset (newest wins).
 * Body: `{ data, snapshots?, updatedAt? }`. With `?snapshot=1` (the explicit
 * "Send to cloud" action) a differing previous version is prepended to the
 * stored snapshots before being replaced, so an accidental overwrite is always
 * restorable. Never creates a second record for an existing name.
 */
async function putPreset(request, env, identity, name, url) {
  let parsed;
  try {
    parsed = JSON.parse(await request.text());
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (typeof parsed !== 'object' || parsed === null || !('data' in parsed)) {
    return json({ error: 'invalid_shape' }, 400);
  }

  const key = presetPrefix(identity) + name;
  const existingRaw = await env.PRESETS.get(key);
  let existing = null;
  if (existingRaw) {
    try {
      existing = JSON.parse(existingRaw);
    } catch {
      existing = null; // corrupt record — treat as absent and overwrite
    }
  }

  const updatedAt =
    typeof parsed.updatedAt === 'string' && parsed.updatedAt
      ? parsed.updatedAt
      : new Date().toISOString();

  // Snapshots: the client may sync its own list (web library pushes); when it
  // doesn't, the cloud's existing list is preserved.
  let snapshots = Array.isArray(parsed.snapshots) ? parsed.snapshots : existing?.snapshots || [];
  if (
    url.searchParams.get('snapshot') === '1' &&
    existing &&
    existing.data !== undefined &&
    JSON.stringify(existing.data) !== JSON.stringify(parsed.data)
  ) {
    snapshots = [
      {
        id: crypto.randomUUID(),
        name: snapshotLabel(existing.updatedAt),
        createdAt: existing.updatedAt || updatedAt,
        data: existing.data,
      },
      ...snapshots,
    ];
  }
  snapshots = snapshots.slice(0, MAX_SNAPSHOTS);

  await env.PRESETS.put(key, JSON.stringify({ name, updatedAt, data: parsed.data, snapshots }), {
    metadata: { updatedAt },
  });
  return json({ ok: true, updatedAt, existed: Boolean(existingRaw) });
}

async function handlePresets(request, env, url) {
  if (!env.PRESETS) return json({ error: 'kv_not_configured' }, 503);

  const identity = await identify(request, env);
  if (!identity) return json({ error: 'unauthenticated' }, 401);

  const { name, error } = presetNameFromPath(url.pathname);
  if (error) return json({ error }, 400);

  // Collection route: the index.
  if (name === null) {
    if (request.method === 'GET') return listPresets(env, identity);
    return json({ error: 'method_not_allowed' }, 405);
  }

  const key = presetPrefix(identity) + name;

  if (request.method === 'GET') {
    const stored = await env.PRESETS.get(key);
    if (!stored) return json({ error: 'not_found' }, 404);
    return new Response(stored, {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  if (request.method === 'PUT') return putPreset(request, env, identity, name, url);

  if (request.method === 'DELETE') {
    await env.PRESETS.delete(key);
    return json({ ok: true });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/');
    const cors = isApi ? corsHeaders(request, env) : {};

    // CORS preflight for any API route.
    if (isApi && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (isApi) {
      // Auth + API-key routes.
      const authResponse = await handleAuth(request, env, url);
      if (authResponse) return withCors(authResponse, cors);

      if (url.pathname === '/api/presets' || url.pathname.startsWith('/api/presets/')) {
        return withCors(await handlePresets(request, env, url), cors);
      }
      return withCors(json({ error: 'not_found' }, 404), cors);
    }

    // Everything else: static assets, with SPA fallback (not_found_handling).
    return env.ASSETS.fetch(request);
  },
};
