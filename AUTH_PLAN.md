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

| Surface | Mechanism the author chose | Identity | Recovery |
| --- | --- | --- | --- |
| **Web / mobile app** | **Cloudflare Access** (browser SSO), enabled by the deployer on their URL | `Cf-Access-Authenticated-User-Email` → per-user KV key `user:<email>` | Delegated to the IdP (Google / email OTP) — none to build |
| **Cursor/VSCode extension** | **Shared passphrase** (`X-Sync-Key` header == `SYNC_PASSWORD` worker secret) | Single shared bucket `shared` (all devices that type the passphrase share ONE library) | None — it's a static secret the deployer sets |
| Local `wrangler dev` | `LOCAL_DEV_EMAIL` escape hatch | `user:<email>` | n/a |
| No identity | **Fail closed** → `401`, app runs local-only | — | — |

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
- **Service token ≠ per-user.** A service token authenticates a *machine*, not an
  email — so the extension wouldn't get `Cf-Access-Authenticated-User-Email`. To
  keep the extension's library tied to the *same* user as the web app, the worker
  needs a small change: map an allowed service token (or a token-name claim) to
  that user's key. Mixing per-user-email (web) and per-token (extension) for the
  *same* person is fiddly.
- **Login mechanism differs by surface** (browser SSO vs. pasted client
  id/secret), which only *partly* satisfies "same mechanism on both."

**Verdict:** lowest code, most "Cloudflare-native," best if you're willing to put
the worker on a custom domain and accept a token (not a login) in the extension.

---

### Option B — Build the auth into the Worker (Better Auth / Lucia) with D1 + a free email sender ★ recommended

Own the login. Add an auth library that runs *inside* the worker and issues a
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

**Verdict:** the only option that delivers *all three* asks — Google **and**
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

| | A. Cloudflare Access + Service Token | **B. Worker-native (Better Auth + D1)** ★ | C. Managed SaaS (Clerk/Supabase) |
| --- | --- | --- | --- |
| Google sign-in | ✅ | ✅ | ✅ |
| Email + password | OTP only (no password) | ✅ | ✅ |
| Recovery path | Delegated (Google/OTP) | ✅ reset email | ✅ provider |
| **Same mechanism web + extension** | ⚠️ SSO vs token | ✅ identical bearer token | ✅ |
| Works on `*.workers.dev` (no custom domain) | ❌ needs a zone | ✅ | ✅ |
| Free on a free CF account | ✅ ≤50 users | ✅ ($0, ≤ email cap) | ✅ generous |
| Code to write/own | least | most | little |
| Self-hosted / no 3rd-party | ✅ (CF only) | ✅ (CF + email sender) | ❌ SaaS dep |
| Outbound email needed | no | yes (Resend free) | no (provider) |

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
   the *same* flow as the web app. This replaces the "type a passphrase" model
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
