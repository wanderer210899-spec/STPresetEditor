// Cloudflare Worker entry point.
//
// One Worker serves both the built single-page app (via the ASSETS binding) and
// the /api/presets cloud-sync API (backed by the PRESETS KV namespace). Built to
// be self-hosted: anyone can deploy their own private instance with one click.
//
// There are NO secrets in this file or the repo. The KV namespace is
// auto-provisioned per deployment, and identity is proven at runtime by
// Cloudflare Access.
//
// AUTH MODEL
//   Cloudflare Access authenticates each user in their browser and injects a
//   trusted, un-forgeable header naming them. The KV key is derived from that
//   identity, so every user's library is isolated to them — even on a shared
//   deployment. With no verified identity we FAIL CLOSED (401); the app then
//   runs local-only. Enable Access on your workers.dev URL to turn sync on.

/** Constant-time string comparison (avoids leaking the secret via timing). */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/**
 * Resolve the authenticated identity for this request, or null. Two ways in:
 *   1. Cloudflare Access — trusted, un-forgeable, isolated per user email.
 *   2. App passphrase — works without Access. The deployer sets SYNC_PASSWORD
 *      (a Worker secret) once; every device that enters it shares one library.
 * The returned value is used directly as the KV key, so identities never collide.
 */
function identify(request, env) {
  const email = request.headers.get('Cf-Access-Authenticated-User-Email');
  if (email) return `user:${email}`;

  const key = request.headers.get('X-Sync-Key');
  if (env.SYNC_PASSWORD && key && safeEqual(key, env.SYNC_PASSWORD)) {
    return 'shared';
  }

  // Local `wrangler dev` escape hatch (set LOCAL_DEV_EMAIL in .dev.vars).
  if (env.LOCAL_DEV_EMAIL) return `user:${env.LOCAL_DEV_EMAIL}`;

  return null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function handlePresets(request, env) {
  if (!env.PRESETS) return json({ error: 'kv_not_configured' }, 503);

  const identity = identify(request, env);
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

    await env.PRESETS.put(identity, raw);
    return json({ ok: true, updatedAt: parsed.updatedAt });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/presets') {
      return handlePresets(request, env);
    }
    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'not_found' }, 404);
    }

    // Everything else: static assets, with SPA fallback (not_found_handling).
    return env.ASSETS.fetch(request);
  },
};
