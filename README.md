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
and stay in sync across devices, gated so **only you** can reach them.

### How it works

```
Cloudflare Access (only your email can log in)
  └─ Cloudflare Pages  (https://<project>.pages.dev)
       ├─ static Vue app  (the built dist/)
       └─ /api/presets  GET/PUT  ◄──►  Cloudflare KV  (your presets)
```

- `wrangler.toml` — Pages project config + KV binding.
- `functions/api/presets.js` — the GET/PUT API backed by KV.
- `src/stores/cloudSync.js` — pulls on load, pushes on change (localStorage stays
  as an offline cache). If the API is unreachable the app silently runs local-only,
  so `npm run dev` is unaffected.

The toolbar shows a small dot: green = synced, amber = syncing, red = error,
grey = local only.

### Setup (one time, ~15 minutes)

1. **Create a free Cloudflare account** at <https://dash.cloudflare.com/sign-up>.
2. **Deploy with Pages** → *Workers & Pages* → *Create* → *Pages* → *Connect to Git*,
   pick this repo. Build command `npm run build`, output directory `dist`. Name the
   project `stpreseteditor` (matching `wrangler.toml`). First deploy gives you a
   `https://<project>.pages.dev` URL.
3. **Create the KV store**: run `npx wrangler kv namespace create PRESETS` and copy
   the printed `id`. Uncomment the `[[kv_namespaces]]` block in `wrangler.toml`,
   paste the `id`, commit and push — Pages redeploys automatically.
   _(Or add it in the dashboard: project → Settings → Functions → KV bindings →
   variable `PRESETS`.)_
4. **Lock it down with Cloudflare Access**: *Zero Trust* → *Access* → *Applications*
   → add a **Self-hosted** app for your `<project>.pages.dev` hostname, then add a
   policy **Allow → Emails → your address only**. Everyone else is blocked at the
   edge before the app loads, and the API receives your verified identity.

> **Privacy note:** the app is fully open until step 4 is complete. Enable Access
> before importing anything you want kept private.

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.

## 🤝 Contributing

Contributions are welcome! Please open an issue or submit a pull request if you encounter any bugs or have feature suggestions.

---

Developed by 🤖 using Vue.js and Tailwind CSS.
