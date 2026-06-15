# SillyTavern Preset Editor

<div>
    <img src="https://img.shields.io/badge/Vue-3.x-brightgreen.svg" alt="Vue 3">
    <img src="https://img.shields.io/badge/TailwindCSS-4.x-blue.svg" alt="Tailwind CSS">
    <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License">
</div>

A lightweight, user-friendly web editor for managing SillyTavern `preset.json` files efficiently, powered by Vue.js and Tailwind CSS.

**🌐 Try it online:** [https://stpe.nativus.workers.dev/](https://stpe.nativus.workers.dev/)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FNativu5%2FSTPresetEditor)

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
committed. Each user signs in with their **own** identity through Cloudflare
Access, and every user's library is isolated to them — even if one instance is
shared by several people.

### How it works

```
Cloudflare Access  (each user signs in as themselves)
  └─ Cloudflare Pages  (https://<project>.pages.dev)
       ├─ static Vue app  (the built dist/)
       └─ /api/presets  GET/PUT  ──►  Cloudflare KV   key: user:<email>
                                      (one isolated library per signed-in user)
```

- `wrangler.toml.example` — template for Pages config + KV binding. Copy it to a
  git-ignored `wrangler.toml` (or configure in the dashboard); no ids are committed.
- `functions/api/presets.js` — the GET/PUT API. Authenticates every request via
  Cloudflare Access and stores each user's library under its own key. Fails closed
  (401) when there is no verified identity.
- `src/stores/cloudSync.js` — pulls on load, pushes on change (localStorage stays
  as an offline cache). If the API is unreachable or unauthenticated the app
  silently runs local-only, so `npm run dev` is unaffected.

The toolbar shows a small dot: green = synced, amber = syncing, red = error,
grey = local only.

### Deploy your own private instance (~15 minutes)

Every deployer runs this once on their own Cloudflare account; none of it touches
the shared repo.

1. **Fork/clone this repo** and **create a free Cloudflare account** at
   <https://dash.cloudflare.com/sign-up>.
2. **Deploy with Pages.** Cloudflare's redesigned dashboard hides the Pages
   button (it pushes you toward Workers), so use one of these entry points:
   - **Direct link** — open
     `https://dash.cloudflare.com/?to=/:account/workers-and-pages/create/pages`
     (paste the `:account` part verbatim; it auto-resolves to your account).
   - **Hidden link** — on *Workers & Pages → Create application*, look **below the
     tiles** for the small text *"Looking to deploy Pages? Get started"* and click it.
   - **CLI fallback** (no dashboard) — `npx wrangler pages project create stpreseteditor`.

   On the Pages wizard choose **Connect to Git** (a.k.a. *Import an existing Git
   repository*), pick **your fork**, then set: build command `npm run build`, output
   directory `dist`, project name `stpreseteditor`. First deploy gives you a
   `https://<project>.pages.dev` URL.
3. **Create your KV store and bind it.** Run
   `npx wrangler kv namespace create PRESETS`, then bind it to **your** deployment
   in the dashboard: project → Settings → Bindings → add a **KV namespace** binding
   named `PRESETS` pointing at it. _(CLI deployers can instead copy
   `wrangler.toml.example` → `wrangler.toml` and paste the id there — that file is
   git-ignored, so your id never enters the repo.)_
4. **Turn on authentication with Cloudflare Access.** This is what makes sync
   private, and it is **required** — cloud sync stays off until it is in place:
   *Zero Trust* → *Access* → *Applications* → add a **Self-hosted** app for your
   `<project>.pages.dev` hostname, then add an **Allow** policy listing the
   email(s) permitted to sign in:
   - just **your own** email → a private, single-user instance, or
   - several emails (or a whole identity provider) → a shared instance where each
     person still gets their own isolated library.

   Sign-in works out of the box via one-time email PIN; you can also wire up
   Google/GitHub under *Zero Trust → Settings → Authentication*.

> **No public window:** with no Cloudflare Access identity the API fails closed and
> the app runs **local-only**, so your presets are never exposed before Access is
> set up. Cloud sync switches on the moment Access is in place.

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.

## 🤝 Contributing

Contributions are welcome! Please open an issue or submit a pull request if you encounter any bugs or have feature suggestions.

---

Developed by 🤖 using Vue.js and Tailwind CSS.
