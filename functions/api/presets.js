// Cloudflare Pages Function — mounted automatically at  /api/presets
//
// GET  -> returns your stored preset library document: { updatedAt, data }
// PUT  -> overwrites it with the request body (same shape)
//
// SECURITY MODEL
// --------------
// The real lock is Cloudflare Access (Phase 4): once enabled on this Pages
// project, Cloudflare blocks every unauthenticated request at the edge before
// it ever reaches this code, and injects a trusted, un-spoofable header naming
// the signed-in user. We use that header to scope storage per-identity, so even
// the data is partitioned to you. Before Access is turned on the app is open —
// enable Access to make it truly private.

const FALLBACK_KEY = 'library';

/** Build the KV key for the authenticated user (per-identity isolation). */
function keyForRequest(request) {
  // Cloudflare Access sets this header; clients cannot forge it through Access.
  const email = request.headers.get('Cf-Access-Authenticated-User-Email');
  return email ? `library:${email}` : FALLBACK_KEY;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function onRequestGet({ env, request }) {
  if (!env.PRESETS) {
    // KV not bound yet — tell the client so it falls back to local-only.
    return json({ error: 'kv_not_configured' }, 503);
  }

  const stored = await env.PRESETS.get(keyForRequest(request));
  if (!stored) {
    return json({ updatedAt: null, data: null });
  }
  return new Response(stored, {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function onRequestPut({ env, request }) {
  if (!env.PRESETS) {
    return json({ error: 'kv_not_configured' }, 503);
  }

  const raw = await request.text();

  // Validate shape before persisting so we never store corrupt data.
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (typeof parsed !== 'object' || parsed === null || !('updatedAt' in parsed)) {
    return json({ error: 'invalid_shape' }, 400);
  }

  await env.PRESETS.put(keyForRequest(request), raw);
  return json({ ok: true, updatedAt: parsed.updatedAt });
}
