// Cloudflare Worker entry point.
//
// One Worker serves both the built single-page app (via the ASSETS binding) and
// the cloud-sync + auth API. Built to be self-hosted: anyone can deploy their
// own private, single-user instance.
//
// AUTH MODEL (see worker/auth.js)
//   One deployment = one owner. The owner signs in with email + password
//   (sessions in D1); the VS Code extension / any client authenticates with a
//   generated API key (`X-API-Key`). Identity → KV key, so the library is
//   isolated to the owner. With no verified identity we FAIL CLOSED (401) and
//   the app runs local-only. There are NO secrets in this file or the repo.

import { handleAuth, identify } from './auth.js';

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

async function handlePresets(request, env) {
  if (!env.PRESETS) return json({ error: 'kv_not_configured' }, 503);

  const identity = await identify(request, env);
  if (!identity) return json({ error: 'unauthenticated' }, 401);

  if (request.method === 'GET') {
    const stored = await env.PRESETS.get(identity);
    if (!stored) return json({ updatedAt: null, data: null });
    return new Response(stored, {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  if (request.method === 'PUT') {
    const raw = await request.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    if (typeof parsed !== 'object' || parsed === null || !('updatedAt' in parsed)) {
      return json({ error: 'invalid_shape' }, 400);
    }

    // Conditional write (conflict detection). When the client sends
    // `baseUpdatedAt` — the `updatedAt` of the cloud doc its edits are based
    // on — reject the write with 409 if another device has stored a different
    // version since. Omitting the field keeps the old blind-write behaviour
    // (backward compatible; also the explicit "keep mine" override).
    if ('baseUpdatedAt' in parsed) {
      const stored = await env.PRESETS.get(identity);
      if (stored) {
        let currentAt = null;
        try {
          currentAt = JSON.parse(stored).updatedAt || null;
        } catch {
          // Corrupt stored doc — allow the overwrite.
        }
        if (currentAt !== null && parsed.baseUpdatedAt !== currentAt) {
          return json({ error: 'conflict', updatedAt: currentAt }, 409);
        }
      }
    }

    // Store the normalised document only (baseUpdatedAt is transport, not data).
    await env.PRESETS.put(
      identity,
      JSON.stringify({ updatedAt: parsed.updatedAt, data: parsed.data ?? null }),
    );
    return json({ ok: true, updatedAt: parsed.updatedAt });
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

      if (url.pathname === '/api/presets') {
        return withCors(await handlePresets(request, env), cors);
      }
      return withCors(json({ error: 'not_found' }, 404), cors);
    }

    // Everything else: static assets, with SPA fallback (not_found_handling).
    return env.ASSETS.fetch(request);
  },
};
