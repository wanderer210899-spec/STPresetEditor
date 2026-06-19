# SillyTavern Preset Editor

<div>
    <img src="https://img.shields.io/badge/Vue-3.x-brightgreen.svg" alt="Vue 3">
    <img src="https://img.shields.io/badge/TailwindCSS-4.x-blue.svg" alt="Tailwind CSS">
    <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License">
</div>

FORK of https://github.com/Nativu5/STPresetEditor

... am legit trying to add some features for personal use

> **This fork adds, on top of [Nativu5/STPresetEditor](https://github.com/Nativu5/STPresetEditor):**
> private cross-device **cloud sync with accounts**, a richer **macro engine**
> (Macros 2.0 shorthand, full SillyTavern coverage, live preview), a **VS Code /
> Cursor extension** for editing local preset files, and a **UI/CSS refresh**.
> See [What's new in this fork](#-whats-new-in-this-fork) and
> [Private cloud sync](#-private-cloud-sync-cloudflare) — the one-click deploy
> button lives there.

## 🖼 Overview

The default SillyTavern preset editor offers basic functionality but can be slow and lacks advanced editing features (e.g., macro highlighting, variable management).

This project enhances your editing experience with an intuitive, high-performance and powerful UI/UX.

<table>
  <tr>
    <td align="center" style="border: 1px solid #ddd; padding: 8px;">
      <img src="https://github.com/user-attachments/assets/24a8cbf7-932a-4dba-9852-64752fbc406c" alt="Main Editor" height="200" />
      <br>Prompt Manage & Edit
    </td>
    <td align="center" style="border: 1px solid #ddd; padding: 8px;">
      <img src="https://github.com/user-attachments/assets/86f3ca7b-0a86-4dc7-9ee3-0045fc4544d8" alt="Macro Analysis" height="200" />
      <br>Macro Analysis & Preview
    </td>
    <td align="center" style="border: 1px solid #ddd; padding: 8px;">
      <img src="https://github.com/user-attachments/assets/4a2c883c-710e-40aa-9cce-f3be7770e5ad" alt="Variable Manager" height="200" />
      <br>Variable Tools
    </td>
  </tr>
</table>

## ✨ What's new in this fork

Built on top of **[Nativu5/STPresetEditor](https://github.com/Nativu5/STPresetEditor)**.
That original project provides the core editor; this fork adds the cloud,
authoring, and tooling layers around it.

**Inherited from the original (Nativu5/STPresetEditor):**

- ⚡ Real-time prompt editing with batch selection and drag-and-drop ordering.
- 🧩 Macro syntax highlighting and 🔍 macro analysis with raw/preview modes.
- 📊 Variable management — rename and track usage across all prompts.
- 📥 Import/export of `preset.json`, tavern preset sorting, and i18n (English / 中文).

**New in this fork:**

- ☁️ **Private cloud sync with accounts** — your library follows you across PC and
  mobile, behind an email + password login (and API keys for clients). Self-hosted
  on Cloudflare; see [Private cloud sync](#-private-cloud-sync-cloudflare).
- 🧠 **Upgraded macro engine** — brace-balanced tokenizer (nested / multiline / XML
  macros), the full current SillyTavern macro set, flow control (`{{if}}`/`{{else}}`),
  **Macros 2.0 shorthand** (`{{.local}}` / `{{$global}}`), value simulation in
  preview, and an extensible autocomplete dictionary.
- ✍️ **Focus editor & `{{` autocomplete** — a distraction-free writer with macro and
  variable autocomplete plus a Ctrl+Space snippet/wrap menu.
- 🧩 **VS Code / Cursor extension** — edit SillyTavern preset files locally in the
  full UI and sync them to your cloud; see [`extension/`](extension/).
- 🎨 **UI/UX & CSS optimisations** — a cleaner, editor-focused 3-pane layout and
  shared styling primitives.

## 🚀 Getting Started

1. 📥 **Import**: Load your existing `preset.json` file via the import modal.
2. ✏️ **Edit**: Visually manage, modify, and rearrange prompts effortlessly.
3. 🧩 **Analyze**: Track macros and variables, viewing their usage across prompts.
4. 📤 **Export**: Save and export your updated JSON file for use with SillyTavern.

## 🚧 Development

Run the development server with hot-reloading:

```bash
npm install
npm run dev
```

Access the app at [http://localhost:5173](http://localhost:5173) (default port).

## 🚢 Deployment

Build for production:

```bash
npm run build
```

Deploy the contents of the generated `dist` folder to any static hosting provider (e.g., GitHub Pages, Netlify, Vercel).

### 🪟 Windows Quick Start

Use the bundled batch script to automate the local setup:

1. Ensure Node.js and npm are available in your environment.
2. Double-click `launch-stpreseteditor.bat` (or run it from Command Prompt) inside the project directory.
3. The script installs dependencies when needed and starts the Vite development server.
4. Open [http://localhost:5173](http://localhost:5173) in your browser, and press `Ctrl+C` in the terminal to stop the server when finished.

## 🔐 Private cloud sync (Cloudflare)

By default the editor stores everything in the browser's `localStorage`, which is
**per-device** — your phone and PC would each keep a separate library. This fork
adds an optional **Cloudflare** backend so your presets live in one central place
and stay in sync across devices.

It is **self-hostable and secret-free**: anyone who forks this repo can deploy
their own private instance in minutes. No passwords, API keys, or account-specific
resource ids are committed — the KV namespace and the D1 auth database are bound by
**name only**, so the one-click Deploy button auto-provisions fresh storage in
**your** account. Each deployer gets their **own** Worker, their **own** storage,
and sets their **own** password. Two people who deploy the fork never share data.

### How it works

```
Browser (the app)  ──►  Cloudflare Worker  (https://<name>.<you>.workers.dev)
                          ├─ serves the built SPA            (ASSETS binding)
                          ├─ /api/auth/* , /api/keys  ──►  Cloudflare D1   (accounts)
                          └─ /api/presets  GET/PUT     ──►  Cloudflare KV   (library)
                                 authenticated by EITHER
                                   • the owner's session cookie (web sign-in)
                                   • an API key  → X-API-Key   (VS Code / clients)
                                 both resolve to key: user:<id>
                                 no identity ⇒ 401, the app stays local-only
```

**One deployment = one owner.** You sign in with **email + password**; the first
sign-up claims the instance (then sign-up closes). Recovery needs **no email
service** — see the owner-recovery backdoor below.

- `worker/index.js` + `worker/auth.js` — the Worker: serves the built app, the
  account/auth API, and the GET/PUT presets API. Auth is a **session cookie**
  (web) or a generated **API key** (`X-API-Key`, for the VS Code extension and
  any client). Dependency-free: passwords are PBKDF2 (Web Crypto); sessions and
  API keys are stored only as hashes. Fails closed (401) with no identity.
- `wrangler.jsonc` — Worker config. The KV namespace and **D1** auth database have
  no id committed, so each deployer's storage is auto-provisioned and private.
- `src/stores/cloudSync.js` — pulls on load, pushes on change (localStorage stays
  as an offline cache). If the API is unreachable or signed-out the app silently
  runs local-only, so `npm run dev` is unaffected.

The toolbar shows a small dot: green = synced, amber = syncing, red = error,
grey = local only. The **Settings** dialog footer shows the deployed build commit.

### 1. Deploy your own instance

**One click** —
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wanderer210899-spec/STPresetEditor)

Sign in to Cloudflare; it copies this repo into **your** GitHub account,
**auto-creates your KV namespace**, builds, and deploys your Worker at
`https://<name>.<you>.workers.dev`. _(The button deploys the repo's **default
branch**, and the repo must be **public** for the button to work.)_

**From the CLI instead:**

```bash
# in a clone of your fork
npm install
wrangler d1 create stpreseteditor-auth                 # paste the printed id into wrangler.jsonc
wrangler d1 migrations apply stpreseteditor-auth --remote
npm run deploy                                          # builds, then `wrangler deploy`
```

### 2. Create your account

Open your deployed URL → **Settings → Cloud sync**. The first visit shows
**Create account** (the instance has no owner yet): enter an email + password to
claim it. After that, the same panel is a **Sign in** form on every device.

Optional Worker variables (dashboard → your Worker → **Settings → Variables**):

- `OWNER_EMAIL` — lock sign-up/sign-in to exactly this email (recommended so a
  stranger who finds your URL can't claim the instance first).
- `EMERGENCY_RESET_TOKEN` — enables the **owner-recovery** password reset (below).
- `ALLOWED_ORIGINS` — only needed if a **browser app on another origin** must call
  the API. Comma-separated allowlist of origins permitted to make credentialed
  cross-origin requests. Leave unset (default) for same-origin web + the extension;
  cross-origin browser access stays off, so a sibling site can't read your data.

**Forgot your password? (owner recovery, no email service)**
In the dashboard, set the Worker variable `EMERGENCY_RESET_TOKEN` to any secret
string, then in **Settings → Cloud sync → Forgot password?** enter that token and
a new password. The token is single-use; delete the variable afterwards. Only you
(holder of the Cloudflare dashboard) can do this — that's the security gate.

### 3. Sync — web and VS Code

- **Web (PC + mobile):** open the URL on each device, sign in with the same
  account, and your library syncs both ways automatically.
- **VS Code extension:** in the web app, **Settings → Cloud sync → Generate key**,
  copy the key (shown once), and paste it into the extension's settings. The
  extension sends it as `X-API-Key`, so it shares the same library without a
  browser sign-in. Revoke a key anytime from the same panel.

> To test the synced API locally, run `npm run cf-preview` and apply the auth
> migrations to the local DB first:
> `wrangler d1 migrations apply stpreseteditor-auth --local`.

> **Not on Cloudflare?** `npm run build` still produces a static `dist/` you can host
> anywhere (GitHub Pages, Netlify, Vercel) — it just runs in local-only mode.

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.

## 🤝 Contributing

Contributions are welcome! Please open an issue or submit a pull request if you encounter any bugs or have feature suggestions.

---

Developed by 🤖 using Vue.js and Tailwind CSS.
