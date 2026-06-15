// Cloudflare Pages Function — mounted automatically at  /api/presets
//
// Per-user, authenticated cloud storage for preset libraries. Built to be
// self-hosted: anyone who forks this repo can deploy their OWN private instance.
//
// There are NO secrets in this file or anywhere in the repo. Identity is proven
// at runtime by Cloudflare Access, and the KV namespace is bound per-deployment
// in each deployer's own Cloudflare dashboard (or their local, git-ignored
// wrangler.toml). Nothing instance-specific is committed.
//
// AUTH MODEL
//   Cloudflare Access authenticates each user in their browser and injects a
//   trusted, un-forgeable header naming them. The KV key is derived from that
//   identity, so every user's library is fully isolated to them — even on a
//   shared deployment. With no verified identity we FAIL CLOSED (401); the app
//   then simply runs local-only. Turn on Access to enable cloud sync.

/**
 * Resolve the authenticated identity for this request, or null.
 * @returns {string|null}
 */
function identify(request, env) {
  // Set by Cloudflare Access. Once Access is enabled, Cloudflare strips any
  // client-supplied copy and sets this itself, so it cannot be forged.
  const email = request.headers.get('Cf-Access-Authenticated-User-Email');
  if (email) return email;

  // Escape hatch for local `wrangler pages dev` only (no Access locally). Set
  // via a git-ignored local var; never configure this in production.
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

export async function onRequestGet({ env, request }) {
  if (!env.PRESETS) return json({ error: 'kv_not_configured' }, 503);

  const identity = identify(request, env);
  if (!identity) return json({ error: 'unauthenticated' }, 401);

  const stored = await env.PRESETS.get(kvKey(identity));
  if (!stored) return json({ updatedAt: null, data: null });
  return new Response(stored, {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function onRequestPut({ env, request }) {
  if (!env.PRESETS) return json({ error: 'kv_not_configured' }, 503);

  const identity = identify(request, env);
  if (!identity) return json({ error: 'unauthenticated' }, 401);

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
