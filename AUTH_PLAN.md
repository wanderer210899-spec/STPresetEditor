# Cloud Sync Authentication — Plan & Options

Branch: `feat/cloud-auth` (off `master`). Intended to land in `master` so the
Cloudflare deployment **and** the Cursor/VSCode extension share one real
authentication layer.

Goal (from the product owner): let a user **sign in to sync** with a Google
account or email + password, with a **recovery path**, using the **same
mechanism** in the deployed web app and in the local extension. Prefer something
that works on a **free Cloudflare account**.

---

## 1. What the original author intended (today's design)

Pulled from `EXTENSION_PLAN.md` (§3b.1, M2c) and `worker/index.js` (`identify()`).
The author did **not** build account-based auth with recovery. They layered two
deployer-configured mechanisms and called it done:

| Surface                     | Mechanism the author chose                                                   | Identity                                                                               | Recovery                                                  |
| --------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Web / mobile app**        | **Cloudflare Access** (browser SSO), enabled by the deployer on their URL    | `Cf-Access-Authenticated-User-Email` → per-user KV key `user:<email>`                  | Delegated to the IdP (Google / email OTP) — none to build |
| **Cursor/VSCode extension** | **Shared passphrase** (`X-Sync-Key` header == `SYNC_PASSWORD` worker secret) | Single shared bucket `shared` (all devices that type the passphrase share ONE library) | None — it's a static secret the deployer sets             |
| Local `wrangler dev`        | `LOCAL_DEV_EMAIL` escape hatch                                               | `user:<email>`                                                                         | n/a                                                       |
| No identity                 | **Fail closed** → `401`, app runs local-only                                 | —                                                                                      | —                                                         |

The author's explicit reasoning (EXTENSION_PLAN.md §3b.1):

> Auth from the extension uses **passphrase mode** (`X-Sync-Key`, already
> supported) — it's a plain header that works cross-origin. Cloudflare Access
> mode relies on browser SSO cookies and is **awkward from a webview**, so
> passphrase is the recommended path there.

### Why this falls short of the goal

1. **No accounts.** The passphrase is one shared secret, not a per-user login.
   Everyone who knows it shares the same library; there is no "my account."
2. **No recovery.** A passphrase has no reset flow; Access pushes recovery onto
   Google/OTP and only covers the web app.
3. **Two different mechanisms.** Web app = Access (per-user); extension =
   passphrase (shared). The goal is **one** mechanism on both surfaces.
4. **Access is browser-bound.** The per-user path (Access) cannot be driven
   cleanly from the extension's Node HTTP — the author's own concern.
5. **Access can't sit on a `workers.dev` URL** in the normal way — it needs a
   real domain/zone (see Option A caveat). The README's "enable Access on your
   workers.dev URL" is optimistic.

So: the foundation in `identify()` is reusable (header → identity → KV key), but
a real "sign in / recover" layer that behaves the same in both places does **not
exist yet**. That is what this branch adds.

---

## 2. Design constraints that shape the options

- **Two callers, two transports.** The web app calls the worker **same-origin
  from a browser** (cookies available). The extension calls the worker **from
  Node, cross-origin** (no browser, no cookie jar, no interactive redirect). Any
  "same mechanism on both" answer must work as a **plain HTTP header/bearer
  token**, because that's the only thing the extension host can send.
- **Per-user isolation already exists** — `identify()` returns a string used
  directly as the KV key. We only need to make that string come from a real
  account instead of a shared secret.
- **Free Cloudflare account** = Workers + KV (have it) + optionally D1 (free) +
  Zero Trust free tier (50 users) + Email Routing (inbound only). Outbound email
  (for password reset) is **not** free-native since MailChannels' free Workers
  offer ended (Aug 2024) — it needs a third-party sender's free tier.

---

## 3. Options (researched, June 2026)

### Option A — Cloudflare Access (Zero Trust free, 50 users) + Service Token for the extension

Use Cloudflare's own identity layer. The deployer turns on an Access application
in front of the worker; users log in with **Google** (any Gmail, no Workspace
needed) or **email One-Time PIN** built in. Recovery is delegated — Google
handles password reset; OTP needs no password at all.

- **Web app:** native fit. Browser SSO; the worker already reads
  `Cf-Access-Authenticated-User-Email` → `user:<email>`. Essentially zero code.
- **Extension:** can't do interactive SSO, so use an **Access Service Token**
  (`CF-Access-Client-Id` + `CF-Access-Client-Secret` headers) — the
  Cloudflare-native machine-auth path. Validates at the edge.
- **Recovery:** Google account recovery / email OTP. Nothing to build.
- **Cost:** free up to 50 users.

**Caveats (important):**

- **Needs a real domain/zone.** Access fronts an app on a domain you've added to
  Cloudflare; it does **not** cleanly protect a bare `*.workers.dev` URL. You'd
  need a custom domain on the worker (you must own a domain; Cloudflare's part is
  free). This is the single biggest blocker for "free + native."
- **Service token ≠ per-user.** A service token authenticates a _machine_, not an
  email — so the extension wouldn't get `Cf-Access-Authenticated-User-Email`. To
  keep the extension's library tied to the _same_ user as the web app, the worker
  needs a small change: map an allowed service token (or a token-name claim) to
  that user's key. Mixing per-user-email (web) and per-token (extension) for the
  _same_ person is fiddly.
- **Login mechanism differs by surface** (browser SSO vs. pasted client
  id/secret), which only _partly_ satisfies "same mechanism on both."

**Verdict:** lowest code, most "Cloudflare-native," best if you're willing to put
the worker on a custom domain and accept a token (not a login) in the extension.

---

### Option B — Build the auth into the Worker (Better Auth / Lucia) with D1 + a free email sender ★ recommended

Own the login. Add an auth library that runs _inside_ the worker and issues a
**bearer token (session JWT)**. The web app and the extension both authenticate
the **identical way**: POST credentials → get a token → send
`Authorization: Bearer <token>` on every sync call. `identify()` verifies the
token and returns `user:<id>`.

- **Email + password:** first-class. **Google OAuth:** first-class social
  provider. Both supported by Better Auth on Cloudflare Workers + D1 (D1 is now a
  first-class Better Auth database; free tier).
- **Recovery:** real password-reset email flow. Send via a free transactional
  sender — **Resend free tier = 3,000 emails/mo (100/day)**, ample for resets.
  (Alternatives: MailChannels Email API 100/day, SMTP2GO.)
- **Same mechanism on BOTH surfaces.** The extension's Settings "Sign in" panel
  POSTs to `/api/auth/...` exactly like the web app and stores the returned token
  — no browser SSO, no service token, truly identical UX.
- **No custom domain required.** Works on the existing `*.workers.dev` URL.
- **Cost:** Workers + D1 + KV free; Resend free. **$0** on a free Cloudflare
  account (assuming under the free email cap).

**Caveats:**

- **Most code to write & own** — registration, sessions, reset tokens, rate
  limiting, password hashing. A library (Better Auth / Lucia) does the heavy
  lifting, but it's still our surface to secure and maintain.
- Adds a **D1 database** binding to `wrangler.jsonc` (still one-click deployable,
  but one more provisioned resource) and a `RESEND_API_KEY` secret.
- Self-rolled auth carries the usual security responsibility (we'd lean on a
  vetted library and Cloudflare Turnstile for abuse protection).

**Verdict:** the only option that delivers _all three_ asks — Google **and**
email/password, real recovery, and **one identical mechanism** in web + extension
— while staying on a free Cloudflare account with no custom domain. Recommended.

---

### Option C — Managed auth SaaS (Clerk / Supabase Auth / Firebase Auth); worker just verifies the JWT

Offload everything to a hosted auth provider. The web app and extension use the
provider's SDK/endpoints to sign in (Google + email/password + recovery all
built in and hosted), receive a JWT, and send it to the worker; the worker only
**verifies the JWT** and derives `user:<id>`.

- **Recovery, Google, email/password:** all handled by the provider — least code
  for us.
- **Same mechanism on both:** yes — both surfaces use the provider's hosted
  login + a bearer token.
- **Free tiers (2026):** Supabase Auth & Firebase Auth ~50,000 MAU free; Clerk
  50,000 MAU free. Far beyond personal use.

**Caveats:**

- **Third-party dependency** for a privacy-sensitive, "self-hostable" project —
  contradicts the repo's "no secrets, deploy-your-own" ethos, and ties users'
  sign-in to an external SaaS.
- Extension still needs the provider's **email/password or device flow** (most
  have non-browser paths), so a little glue either way.
- Vendor lock-in; their outage = your sign-in outage.

**Verdict:** least code, fastest to ship, but adds a SaaS dependency that fights
the project's self-hosted, secret-free design. Good fallback if Option B's
maintenance burden isn't wanted.

---

## 4. Comparison at a glance

|                                             | A. Cloudflare Access + Service Token | **B. Worker-native (Better Auth + D1)** ★ | C. Managed SaaS (Clerk/Supabase) |
| ------------------------------------------- | ------------------------------------ | ----------------------------------------- | -------------------------------- |
| Google sign-in                              | ✅                                   | ✅                                        | ✅                               |
| Email + password                            | OTP only (no password)               | ✅                                        | ✅                               |
| Recovery path                               | Delegated (Google/OTP)               | ✅ reset email                            | ✅ provider                      |
| **Same mechanism web + extension**          | ⚠️ SSO vs token                      | ✅ identical bearer token                 | ✅                               |
| Works on `*.workers.dev` (no custom domain) | ❌ needs a zone                      | ✅                                        | ✅                               |
| Free on a free CF account                   | ✅ ≤50 users                         | ✅ ($0, ≤ email cap)                      | ✅ generous                      |
| Code to write/own                           | least                                | most                                      | little                           |
| Self-hosted / no 3rd-party                  | ✅ (CF only)                         | ✅ (CF + email sender)                    | ❌ SaaS dep                      |
| Outbound email needed                       | no                                   | yes (Resend free)                         | no (provider)                    |

---

## 5. Recommended direction — Option B

Deliver a per-user account system inside the worker, identical on both surfaces:

1. **Worker:** add Better Auth (or Lucia) on **D1**; expose `/api/auth/*`
   (register, login, logout, request-reset, reset, Google OAuth callback). Issue
   a session **bearer token**.
2. **`identify()`:** add a branch — verify `Authorization: Bearer <token>` →
   `user:<accountId>`. Keep the existing Access-email and passphrase branches for
   backward compatibility (deprecate the shared passphrase once accounts land).
3. **Web app:** a Sign in / Create account / Forgot password UI; store the token;
   send it on every `/api/presets` call (replaces/augments `X-Sync-Key`).
4. **Extension:** in the webview **Settings → above the passphrase**, a "Sign in
   to sync" panel that POSTs to `<cloudUrl>/api/auth/*`, stores the token via the
   host, and the host attaches `Authorization: Bearer` on its Node HTTP calls —
   the _same_ flow as the web app. This replaces the "type a passphrase" model
   and is what the product owner asked for ("when correct URL typed, trigger a
   Cloudflare authentication … above the passphrase").
5. **Recovery:** password-reset email via **Resend** (free 3k/mo);
   `RESEND_API_KEY` as a worker secret. Add **Cloudflare Turnstile** (free) on
   register/reset to blunt abuse.
6. **Config:** add a `DB` (D1) binding to `wrangler.jsonc` (no id → auto-provisioned,
   preserving the one-click-deploy story); document the `RESEND_API_KEY` secret.

**Fallback:** if the email-sender dependency or maintenance burden is unwanted,
Option C (Supabase Auth — generous free tier, hosted Google + email/password +
recovery) is the fastest path; the worker shrinks to JWT verification only.

**Open decisions to confirm before building** (see chat): (a) Option B vs C; (b)
willingness to add a D1 database; (c) keep the shared passphrase as a legacy
fallback or remove it; (d) Resend vs another free sender; (e) whether a custom
domain is on the table (only needed if we ever revisit Option A).

---

## 6. DECISION — Option B, self-hosted variant ("no email, owner recovery, API keys")

Product owner chose **Option B** with three modifications that suit a self-hosted
deployment better than the generic plan:

1. **No email provider.** Drop Resend / password-reset emails entirely.
2. **Owner recovery via env-var backdoor.** A "forgot password" flow that only
   works when a secret the user sets in their **Cloudflare dashboard** is present
   (e.g. `EMERGENCY_RESET_TOKEN`). Because only the deployment owner can set
   worker variables, this is the recovery gate — $0, no third party.
3. **Extension auth via generated API keys.** The web dashboard mints a
   long-lived **API key** (PAT-style); the user pastes it into the extension
   settings; the worker validates the key against D1 on every request. Replaces
   the shared `X-Sync-Key` passphrase. No browser-OAuth-in-a-webview needed.

Stack: Cloudflare Workers + **D1** (accounts, API keys) + KV (presets, unchanged)

- Better Auth (login). **$0 on a free Cloudflare account, no email service, no
  custom domain.**

### Hardening to apply (not optional)

- **Store only hashes.** API keys and passwords stored as hashes in D1; the
  plaintext API key is shown **once** at generation (PAT model). Reuse the
  worker's existing constant-time `safeEqual()` for token comparisons.
- **Single-use backdoor.** After a successful emergency reset, prompt the user to
  delete the env var, and record the consumed token value in D1 so it can't be
  replayed while still set. (Mechanics: dashboard plaintext vars apply on next
  save/deploy; secrets via `wrangler secret put` — not instant.)
- **API keys are first-class:** support multiple keys, names, `last_used_at`, and
  revoke. Validate via `Authorization: Bearer`/`X-API-Key` header in `identify()`.

### `identify()` after this change

```
1. Authorization: Bearer <session token>  → user:<id>   (web app, logged-in browser)
2. X-API-Key: <generated key>             → user:<id>   (extension / any client)
3. (emergency reset endpoint only) env EMERGENCY_RESET_TOKEN match → allow reset
4. else → 401 (fail closed, local-only)        # shared X-Sync-Key retired
```

### TWO open forks that finalize the design

- **Scope — single-user vs multi-user.** Owner-recovery (env var) only works for
  the **dashboard owner**. Single-user → perfect, and "accounts" collapse to one
  owner credential + API keys (registration/Google optional). Multi-user (friends
  each with their own login) → a non-owner who forgets their password can't set
  your env var, so multi-user needs Google OAuth (Google handles their recovery)
  or email reset for non-owners.
- **Sign-in credential — password+backdoor vs Google vs both.** Password +
  owner-backdoor = fully self-contained (no Google, no email). Google OAuth =
  no password to forget and Google handles recovery, but depends on Google. They
  compose: Google for humans + API keys for clients can drop passwords entirely.

## 7. Implementation plan (build-ready)

**Model: one deployment = one owner.** The repo stays open-source and one-click
deployable; each deploy is a **single-user** instance owned by whoever deploys
it. Sign in with **Google OR email + password**. Recovery: Google via Google;
password via the **env-var owner backdoor**. The extension authenticates with a
generated **API key**. Presets stay in KV (key shape `user:<ownerId>`, unchanged).

### 7.1 Establishing the owner (first-run claim)

A fresh instance has no account. To stop a stranger who finds the URL from
claiming it:

- If env `OWNER_EMAIL` is set → only that email may register/sign in (Google
  email must match; the single password account must use it). Dashboard-gated,
  consistent with the backdoor philosophy. **Recommended default.**
- Else → **first registration claims ownership and locks further signups**
  (lower friction; show the claimed identity in Settings).

### 7.2 Data — Cloudflare D1 (new binding `DB`)

```sql
-- Better Auth manages user/account/session tables (its schema/migrations).
-- We add one table for client credentials:
CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,        -- random id
  user_id     TEXT NOT NULL,           -- owner
  name        TEXT,                    -- e.g. "Work laptop VSCode"
  key_hash    TEXT NOT NULL,           -- SHA-256 of the key; plaintext shown ONCE
  prefix      TEXT NOT NULL,           -- first 8 chars, for display/lookup
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX idx_api_keys_prefix ON api_keys(prefix);
-- consumed emergency-reset tokens, so a still-set env var can't be replayed:
CREATE TABLE used_reset_tokens (token_hash TEXT PRIMARY KEY, used_at INTEGER);
```

KV `PRESETS` is unchanged.

### 7.3 Worker (`worker/index.js`)

- Mount **Better Auth** at `/api/auth/*` (email+password + Google provider),
  backed by D1. Secrets: `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`.
- New endpoints:
  - `POST /api/keys` (session-auth) → mint API key, return plaintext **once**.
  - `GET /api/keys` / `DELETE /api/keys/:id` → list / revoke.
  - `POST /api/auth/emergency-reset` → if `env.EMERGENCY_RESET_TOKEN` is set and
    the body token matches (constant-time `safeEqual`) and isn't in
    `used_reset_tokens`, set a new password and record the token as consumed.
- Rewrite `identify(request, env)` priority:
  1. valid Better Auth **session** (cookie or `Authorization: Bearer`) → `user:<id>`
  2. valid **`X-API-Key`** (hash → lookup → not revoked; touch `last_used_at`) → `user:<id>`
  3. else `null` → `401` (retire the shared `X-Sync-Key` branch)
- **CORS**: the extension is cross-origin. Answer `OPTIONS` preflight and send
  `Access-Control-Allow-Origin` (echo the configured origin),
  `Access-Control-Allow-Headers: authorization, x-api-key, content-type`,
  `Access-Control-Allow-Credentials: true` on `/api/auth/*` and `/api/presets`.
- Reuse the existing constant-time `safeEqual()` for all token compares; store
  only hashes.

### 7.4 `wrangler.jsonc`

- Add a `d1_databases` binding `DB` (database provisioned on deploy; document the
  one-click flow / `wrangler d1 create`).
- Document required vars/secrets in README: `BETTER_AUTH_SECRET`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, optional `OWNER_EMAIL`, optional
  `EMERGENCY_RESET_TOKEN`. No secrets committed (keeps the repo's ethos).

### 7.5 Web app (`src/`)

- **Login view**: "Sign in with Google" button + email/password form +
  "Forgot password?" (explains the dashboard env-var reset steps).
- **Settings → Account**: show signed-in identity; **"Connect VS Code"** →
  generates an API key, shows it once with copy button; list keys (name, prefix,
  last used) + revoke.
- `cloudSync.js`: send the session (Bearer) instead of `X-Sync-Key`.

### 7.6 Extension (coordinate with the extension branch — see §7.8)

- Settings, **above the old passphrase field**: a cloud URL field + an **API key**
  field. On entry, ping `/api/presets` (or `/api/auth/whoami`) with `X-API-Key`;
  on `200` show "Connected as <email>". This is the "type URL → triggers
  authentication" UX the owner asked for.
- Host (`extension/extension.js`) attaches `X-API-Key` on its Node HTTP calls
  (replacing `X-Sync-Key`). Remove/retire the passphrase relay.

### 7.7 Milestones

| #      | Outcome                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------- |
| **A0** | D1 + Better Auth wired into the worker; `/api/auth/*` (Google + password) live; first-run owner claim |
| **A1** | `identify()` rewritten (session + API key); `/api/presets` gated by it; CORS; `X-Sync-Key` retired    |
| **A2** | Web login view (Google + password) + Account page with API-key generate/list/revoke                   |
| **A3** | Emergency-reset endpoint + env-var backdoor (single-use, constant-time)                               |
| **A4** | Extension Settings API-key field above passphrase; host sends `X-API-Key`; passphrase retired         |
| **A5** | Polish: README deploy vars, Turnstile (optional) on auth endpoints, migration notes                   |

### 7.8 Cross-branch note (important)

This branch is off **`master`, which has NO `extension/` directory** — the
extension lives only on `claude/laughing-brown-2m6ked`. So **A0–A3, A5 (worker +
web)** land here and flow to `master` → the Cloudflare instance. **A4 (extension)**
must be coordinated: either rebase the extension branch onto this one after merge,
or cherry-pick A4 there. Plan the worker/web auth as fully usable on its own
(web app gets real accounts immediately); the extension adopts the API key once
the branches are reconciled.

## 8. Sync setup UX per platform

One shared Vue component **`<SyncSetup>`** renders in all three shapes (the
codebase already detects the shape via `isVsCodeHost()`), so the panel looks the
same everywhere; only the auth action differs.

| Platform       | What the user does                                                                                                                                                                  | Why                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **PC web**     | Open the deployment URL → Sync panel → enter email + password → done. First sign-in claims ownership.                                                                               | Same-origin: the session cookie just works; presets sync automatically. No URL, no key.                                           |
| **Mobile web** | **Identical** to PC web — same URL, same component, responsive. Sign in with the same password → same library.                                                                      | It's literally the same deployed app in another browser. This is the cross-device payoff.                                         |
| **PC VS Code** | Settings (panel above the old passphrase): enter **Cloud URL** + paste an **API key** generated in the web app (Settings → _Connect VS Code_). Pings the worker → "Connected as …". | The webview is a different origin and can't ride the browser session, so it authenticates with a header credential (the API key). |

**"Same UI" outcome:** PC web ≡ mobile web is identical for free. VS Code reuses
the same panel component; for v1 its action is "Cloud URL + API key" (vs. the web's
"email + password"). A later **device-link** upgrade will make VS Code bounce to
the same web login screen so all three converge on one sign-in screen.

## 9. v1 scope lock (confirmed)

- **Password only.** No Google sign-in in v1 — it would force every deployer to
  create a per-deployment Google OAuth client (Cloud Console), which is heavier
  than a password for a single-user self-host. **Keep the Google provider wired
  in Better Auth but dormant**, enabled only when `GOOGLE_CLIENT_ID` is present —
  so adding Google later is a config change, not a rewrite.
- **Recovery:** env-var owner backdoor only (no email service).
- **Extension:** paste-API-key for v1; **device-link deferred** to v2.
- **Deployer setup for v1 is minimal:** set `BETTER_AUTH_SECRET` (and optionally
  `OWNER_EMAIL`, `EMERGENCY_RESET_TOKEN`). No external accounts, no email, no
  custom domain.

### Revised milestones

| #      | Outcome                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| **A0** | D1 + Better Auth (email/password only; Google provider present but dormant); first-run owner claim                  |
| **A1** | `identify()` rewritten (session + `X-API-Key`); `/api/presets` gated; CORS; `X-Sync-Key` retired                    |
| **A2** | Web `<SyncSetup>`: login (password) + Account page with API-key generate / list / revoke                            |
| **A3** | Emergency-reset endpoint + env-var backdoor (single-use, constant-time)                                             |
| **A4** | Extension `<SyncSetup>`: Cloud URL + paste-API-key above the passphrase; host sends `X-API-Key`; passphrase retired |
| **A5** | Polish: README deploy vars, optional Turnstile on login; **v2 stubs:** enable-Google switch, device-link pairing    |

## 10. Implementation status

Worker + web were built on `feat/cloud-auth`; **A4 (extension)** landed when that
branch was merged into the extension branch (`claude/laughing-brown-2m6ked`), so
all of A0–A5 now live together here.

| #   | Status | Notes                                                                                          |
| --- | ------ | --------------------------------------------------------------------------------------------- |
| A0  | ✅     | `worker/auth.js` + D1 migrations; first-run owner claim (optional `OWNER_EMAIL`)               |
| A1  | ✅     | `identify()` = session → `X-API-Key`; `/api/presets` gated; CORS; `X-Sync-Key` removed         |
| A2  | ✅     | `authStore.js` + `SyncSetup.vue` in Settings; en/zh i18n                                       |
| A3  | ✅     | `/api/auth/emergency-reset`, single-use, constant-time, invalidates sessions                   |
| A4  | ✅     | `SyncSetup.vue` VS Code branch (URL + paste API key); host sends `X-API-Key`, key in SecretStorage; validates via `/api/auth/me` |
| A5  | ✅     | README + CLAUDE.md updated; v2 (Google/device-link) noted below                                |

**Implementation note — no Better Auth in v1.** Given the v1 scope (single-user,
password-only, no email), auth is a lean, dependency-free core on the Workers
Web Crypto API (PBKDF2 password hashing, D1-backed sessions, SHA-256 API keys)
instead of the Better Auth framework. Same endpoints / `identify()` contract /
UX as planned, but far easier to run under `wrangler dev` and deploy, and small
enough to audit. **v2** (Google sign-in, device-link pairing) can be added behind
the same `/api/auth/*` surface.

## Sources

- Cloudflare Zero Trust plans (free, 50 users): https://www.cloudflare.com/plans/zero-trust-services/
- Access service tokens (non-browser auth): https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- Access One-Time PIN login: https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/
- Access + Google (any Gmail, no Workspace): https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/
- Workers routing / workers.dev vs custom domain: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Better Auth + Cloudflare D1: https://github.com/zpg6/better-auth-cloudflare
- Send email from Workers with Resend: https://developers.cloudflare.com/workers/tutorials/send-emails-with-resend/
- Resend free tier (3k/mo, 100/day): https://resend.com/pricing
- Clerk / Supabase / Firebase auth free tiers (~50k MAU): https://www.buildmvpfast.com/api-costs/authentication
