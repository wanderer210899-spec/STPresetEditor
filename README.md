# SillyTavern Preset Editor

<div>
    <img src="https://img.shields.io/badge/Vue-3.x-brightgreen.svg" alt="Vue 3">
    <img src="https://img.shields.io/badge/TailwindCSS-4.x-blue.svg" alt="Tailwind CSS">
    <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License">
</div>

A lightweight, user-friendly web editor for managing SillyTavern `preset.json` files efficiently, powered by Vue.js and Tailwind CSS.

**🌐 Try it online:** [https://stpe.nativus.workers.dev/](https://stpe.nativus.workers.dev/)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wanderer210899-spec/STPresetEditor)

> This fork adds **private, cross-device cloud sync** on Cloudflare — see
> [Private cloud sync](#-private-cloud-sync-cloudflare) below. The one-click button
> deploys your own instance and auto-creates its storage.

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

## 🎯 Key Features

- ⚡ **Real-time Editing & Saving**: Instantly edit prompts with batch selection and drag-and-drop. Changes are saved locally for secure, persistent editing.
- 🧩 **Syntax Highlighting**: Automatically highlight special macros within prompts, enabling quick reference.
- 🔍 **Macro Analysis & Preview**: Instantly analyze macros and switch between raw and preview modes for efficient editing.
- 📊 **Variable Management**: Efficiently rename and track variable usage across all prompts.

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
their own private instance in minutes. No keys or deployment-specific ids are
committed — each deployer gets their **own** Worker, their **own** storage, and
sets their **own** password. Two people who deploy the fork never share data.

### How it works

```
Browser (the app)  ──►  Cloudflare Worker  (https://<name>.<you>.workers.dev)
                          ├─ serves the built SPA            (ASSETS binding)
                          └─ /api/presets  GET/PUT  ──►  Cloudflare KV
                                 authenticated by EITHER
                                   • a shared passphrase       → key: shared
                                   • a Cloudflare Access email → key: user:<email>
                                 no identity ⇒ 401, the app stays local-only
```

- `worker/index.js` — the Worker: serves the built app **and** the GET/PUT API.
  Authenticates each request via **a passphrase** (the `SYNC_PASSWORD` secret) **or
  Cloudflare Access**, and stores each identity's library under its own KV key.
  Fails closed (401) when there is no verified identity.
- `wrangler.jsonc` — Worker config. Committed and secret-free: the KV namespace has
  no id, so Cloudflare **auto-provisions a fresh one for each deployer**.
- `src/stores/cloudSync.js` — pulls on load, pushes on change (localStorage stays
  as an offline cache). If the API is unreachable or unauthenticated the app
  silently runs local-only, so `npm run dev` is unaffected.

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
npm run deploy        # builds, then `wrangler deploy` (auto-provisions KV)
```

### 2. Turn on authentication — required (pick one)

Until you do this, the API fails closed (401) and the app runs **local-only**, so
your presets are never exposed.

**Option A — Passphrase (simplest, recommended):**

```bash
npx wrangler secret put SYNC_PASSWORD     # then type your chosen passphrase
```

On each device, open the app → **Settings → Cloud sync**, enter the **same**
passphrase, and click **Connect**. Every device that knows the passphrase shares
one private library. Change it anytime by re-running the command — your data is
kept, because the passphrase only unlocks access (it is not the storage key).

**Option B — Cloudflare Access (email-based, per-user isolation):**

In the dashboard open your Worker → **Settings** → enable **Cloudflare Access for
workers.dev** (sets up free Zero Trust if needed), then edit the Access policy to
allow only the email(s) you choose. Each signed-in email gets its **own** isolated
library. Sign-in works via one-time email PIN; Google/GitHub can be added under
*Zero Trust → Settings → Authentication*.

### 3. Sync

Open the URL on your phone and PC, authenticate the same way on each, and import a
preset — it now syncs both ways.

> To test the synced API locally without auth, run `npm run cf-preview` with a
> git-ignored `.dev.vars` file containing `LOCAL_DEV_EMAIL=you@example.com`.

> **Not on Cloudflare?** `npm run build` still produces a static `dist/` you can host
> anywhere (GitHub Pages, Netlify, Vercel) — it just runs in local-only mode.

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.

## 🤝 Contributing

Contributions are welcome! Please open an issue or submit a pull request if you encounter any bugs or have feature suggestions.

---

Developed by 🤖 using Vue.js and Tailwind CSS.
