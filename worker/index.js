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

/** Resolve the authenticated identity for this request, or null. */
function identify(request, env) {
  // Set by Cloudflare Access; once Access is on, Cloudflare sets it itself and
  // strips any client-supplied copy, so it cannot be forged.
  const email = request.headers.get('Cf-Access-Authenticated-User-Email');
  if (email) return email;

  // Escape hatch for local `wrangler dev` only (no Access locally). Provide via a
  // git-ignored .dev.vars file; never configure this in production.
  if (env.LOCAL_DEV_EMAIL) return env.LOCAL_DEV_EMAIL;

  return null;
}

/** Per-identity KV key, so no two users ever share a bucket. */
function kvKey(identity) {
  return `user:${identity}`;
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
    const stored = await env.PRESETS.get(kvKey(identity));
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

    await env.PRESETS.put(kvKey(identity), raw);
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
