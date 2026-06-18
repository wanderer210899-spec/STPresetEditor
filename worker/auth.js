// Authentication core for STPresetEditor cloud sync.
//
// Single-user model: ONE deployment = ONE owner. The first registration claims
// the instance (optionally locked to OWNER_EMAIL); after that, sign-up is closed.
// Sign in with email + password. The VS Code extension (and any non-browser
// client) authenticates with a generated API key sent as `X-API-Key`.
//
// Zero dependencies: everything here is built on the Workers-native Web Crypto
// API and Cloudflare D1. Passwords are PBKDF2-HMAC-SHA256; sessions and API keys
// are random tokens stored only as SHA-256 hashes (the plaintext is shown once).
//
// Recovery has no email service: the deployer sets EMERGENCY_RESET_TOKEN in the
// Worker dashboard and POSTs it once to reset the password (see emergencyReset).

const SESSION_COOKIE = 'stpe_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PBKDF2_ITERS = 210000;

const encoder = new TextEncoder();

/** Constant-time comparison of two strings (timing-safe). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Random opaque token, hex-encoded (default 32 bytes / 256 bits). */
function randomToken(bytes = 32) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return toHex(new Uint8Array(digest));
}

// --- Password hashing (PBKDF2-HMAC-SHA256) -----------------------------------

async function derivePbkdf2(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/** Produce a self-describing password hash string: `pbkdf2$iters$saltB64$hashB64`. */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePbkdf2(password, salt, PBKDF2_ITERS);
  return `pbkdf2$${PBKDF2_ITERS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Verify a password against a stored `pbkdf2$...` string (timing-safe). */
export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  const salt = fromBase64(parts[2]);
  const expected = parts[3];
  const actual = toBase64(await derivePbkdf2(password, salt, iterations));
  return safeEqual(actual, expected);
}

// --- Cookies -----------------------------------------------------------------

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const jar = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) jar[name] = decodeURIComponent(value);
  }
  return jar;
}

function sessionCookie(token, maxAgeSec) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  return attrs.join('; ');
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// --- Owner / users -----------------------------------------------------------

async function getOwner(env) {
  // Single-user: at most one row. Pick the earliest as the canonical owner.
  return env.DB.prepare('SELECT * FROM users ORDER BY created_at ASC LIMIT 1').first();
}

/** Whether an owner has been established yet (drives "Create account" vs "Sign in"). */
export async function ownerExists(env) {
  return Boolean(await getOwner(env));
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 256;
}

// --- Sessions ----------------------------------------------------------------

async function createSession(env, userId) {
  const token = randomToken();
  const id = await sha256Hex(token);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  )
    .bind(id, userId, now, now + SESSION_TTL_MS)
    .run();
  return token;
}

async function destroySession(env, token) {
  if (!token) return;
  const id = await sha256Hex(token);
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

/** Resolve the user behind a session cookie, or null. Expired sessions are pruned. */
async function userFromSession(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const id = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?')
    .bind(id)
    .first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return null;
  }
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first();
}

// --- API keys ----------------------------------------------------------------

const API_KEY_PREFIX = 'stpe_';

/** Resolve the user behind an `X-API-Key` header, or null. Touches last_used_at. */
async function userFromApiKey(request, env) {
  const key = request.headers.get('X-API-Key');
  if (!key) return null;
  const keyHash = await sha256Hex(key);
  const row = await env.DB.prepare(
    'SELECT id, user_id, revoked_at FROM api_keys WHERE key_hash = ?',
  )
    .bind(keyHash)
    .first();
  if (!row || row.revoked_at) return null;
  // Best-effort last-used stamp; never blocks auth.
  env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
    .bind(Date.now(), row.id)
    .run()
    .catch(() => {});
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first();
}

// --- Public: identity resolution (used by the presets API) -------------------

/**
 * Resolve the authenticated identity string (used directly as the KV key), or
 * null. Order: session cookie (browser) → X-API-Key (extension / clients).
 * Backwards-compatible LOCAL_DEV_EMAIL escape hatch for `wrangler dev`.
 */
export async function identify(request, env) {
  if (env.DB) {
    const sessionUser = await userFromSession(request, env);
    if (sessionUser) return `user:${sessionUser.id}`;

    const apiUser = await userFromApiKey(request, env);
    if (apiUser) return `user:${apiUser.id}`;
  }

  if (env.LOCAL_DEV_EMAIL) return `user:${env.LOCAL_DEV_EMAIL}`;
  return null;
}

// --- Public: HTTP handlers ---------------------------------------------------

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders },
  });
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

/**
 * Route every `/api/auth/*` and `/api/keys*` request. Returns a Response, or
 * null if the path is not an auth route (so the caller can fall through).
 */
export async function handleAuth(request, env, url) {
  const { pathname } = url;
  if (!env.DB) return json({ error: 'db_not_configured' }, 503);

  // --- /api/auth/me : who am I, and is setup needed? ---
  if (pathname === '/api/auth/me' && request.method === 'GET') {
    const user = (await userFromSession(request, env)) || (await userFromApiKey(request, env));
    if (user) return json({ authenticated: true, email: user.email, id: user.id });
    return json({ authenticated: false, needsSetup: !(await ownerExists(env)) });
  }

  // --- /api/auth/register : claim the instance (first run only) ---
  if (pathname === '/api/auth/register' && request.method === 'POST') {
    if (await ownerExists(env)) return json({ error: 'owner_exists' }, 403);
    const { email, password } = await readJson(request);
    const addr = normalizeEmail(email);
    if (!addr || !addr.includes('@')) return json({ error: 'invalid_email' }, 400);
    if (env.OWNER_EMAIL && normalizeEmail(env.OWNER_EMAIL) !== addr) {
      return json({ error: 'email_not_allowed' }, 403);
    }
    if (!validPassword(password)) return json({ error: 'weak_password' }, 400);

    const id = randomToken(16);
    await env.DB.prepare(
      'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(id, addr, await hashPassword(password), Date.now())
      .run();
    const token = await createSession(env, id);
    return json({ ok: true, email: addr }, 200, {
      'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000),
    });
  }

  // --- /api/auth/login ---
  if (pathname === '/api/auth/login' && request.method === 'POST') {
    const { email, password } = await readJson(request);
    const addr = normalizeEmail(email);
    const owner = await getOwner(env);
    // Run verification even when the user is unknown to keep timing uniform.
    const stored = owner && owner.email === addr ? owner.password_hash : '';
    const ok = (await verifyPassword(password || '', stored)) && owner && owner.email === addr;
    if (!ok) return json({ error: 'invalid_credentials' }, 401);
    const token = await createSession(env, owner.id);
    return json({ ok: true, email: owner.email }, 200, {
      'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000),
    });
  }

  // --- /api/auth/logout ---
  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    await destroySession(env, parseCookies(request)[SESSION_COOKIE]);
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
  }

  // --- /api/auth/emergency-reset : owner backdoor, no email ---
  if (pathname === '/api/auth/emergency-reset' && request.method === 'POST') {
    return emergencyReset(request, env);
  }

  // --- /api/keys : list / create (session only) ---
  if (pathname === '/api/keys') {
    const user = await userFromSession(request, env);
    if (!user) return json({ error: 'unauthenticated' }, 401);

    if (request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
      )
        .bind(user.id)
        .all();
      return json({ keys: results || [] });
    }

    if (request.method === 'POST') {
      const { name } = await readJson(request);
      const key = `${API_KEY_PREFIX}${randomToken(24)}`;
      const id = randomToken(12);
      const prefix = key.slice(0, 12);
      await env.DB.prepare(
        'INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind(
          id,
          user.id,
          typeof name === 'string' ? name.slice(0, 80) : null,
          await sha256Hex(key),
          prefix,
          Date.now(),
        )
        .run();
      // Plaintext returned exactly once — never stored.
      return json({ ok: true, id, name: name || null, prefix, key });
    }
    return json({ error: 'method_not_allowed' }, 405);
  }

  // --- /api/keys/:id : revoke (session only) ---
  if (pathname.startsWith('/api/keys/') && request.method === 'DELETE') {
    const user = await userFromSession(request, env);
    if (!user) return json({ error: 'unauthenticated' }, 401);
    const id = decodeURIComponent(pathname.slice('/api/keys/'.length));
    await env.DB.prepare(
      'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    )
      .bind(Date.now(), id, user.id)
      .run();
    return json({ ok: true });
  }

  return null; // not an auth route
}

/**
 * Owner-recovery password reset, gated by the EMERGENCY_RESET_TOKEN worker var.
 * Single-use: a consumed token is recorded so it can't be replayed while the
 * deployer forgets to delete the var. All sessions are invalidated on reset.
 */
async function emergencyReset(request, env) {
  if (!env.EMERGENCY_RESET_TOKEN) return json({ error: 'reset_disabled' }, 403);
  const { token, newPassword } = await readJson(request);
  if (typeof token !== 'string' || !safeEqual(token, env.EMERGENCY_RESET_TOKEN)) {
    return json({ error: 'invalid_token' }, 403);
  }
  if (!validPassword(newPassword)) return json({ error: 'weak_password' }, 400);

  const tokenHash = await sha256Hex(token);
  const consumed = await env.DB.prepare('SELECT 1 FROM used_reset_tokens WHERE token_hash = ?')
    .bind(tokenHash)
    .first();
  if (consumed) return json({ error: 'token_already_used' }, 403);

  const owner = await getOwner(env);
  if (!owner) return json({ error: 'no_owner' }, 404);

  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(
      await hashPassword(newPassword),
      owner.id,
    ),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(owner.id),
    env.DB.prepare('INSERT INTO used_reset_tokens (token_hash, used_at) VALUES (?, ?)').bind(
      tokenHash,
      Date.now(),
    ),
  ]);
  return json({ ok: true, email: owner.email });
}
