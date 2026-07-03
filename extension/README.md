# STPresetEditor — Local Files (extension)

Edit SillyTavern presets straight from local files using the full STPresetEditor
UI, inside Cursor/VSCode. Open a `.json` preset → edit in the rich UI → it saves
back to the same file automatically.

> Phase M0 + M1 + M2c of `../EXTENSION_PLAN.md`, plus the **ST Presets**
> folder-workspace view with optional folder↔cloud library sync (F5, see
> section 8 of the plan). Not yet included: live SillyTavern reload (M3).

## Cloud sync (optional, opt-in)

Cloud sync is **off until you point it at your own deployment** — the extension
has no built-in endpoint and contacts no server until you configure one. Each
person runs their **own** Cloudflare Worker (one-click deploy; see the project
README), so nobody's data is shared.

The extension and the web app now share **one account system**. The web app
signs in with email + password; the extension authenticates with an **API key**
your account mints:

1. Open your deployment **in a browser**, sign in, then go to **Settings → Cloud
   sync → Generate key**. Copy the key (`stpe_…`) — it is shown only once.
2. In the editor (this extension), open **Settings → Cloud sync**, paste your
   **Worker URL** and the **API key**, and click **Connect**. It pings the worker
   and shows **"Signed in as &lt;you&gt;"**.

Then:

- On edit, the PC pushes the **current preset** to your cloud — your phone's
  saved library is never overwritten (the host does a safe read-merge-write of
  only the current-preset fields).
- To bring a preset you edited on your phone down to the PC, click
  **"☁ Pull preset"** in the status bar (or run **STPresetEditor: Pull preset
  from cloud**). It loads into the editor and saves to the open file.

Security notes: traffic is HTTPS and authenticated by your API key (`X-API-Key`);
the Worker fails closed without a valid key. The key is held in the editor's
encrypted **SecretStorage**, never written to the repo, and never shown back to
the web UI. You can **revoke** a key anytime from the web app (Settings → Cloud
sync). The Worker has no built-in rate limiting, so consider a WAF rate-limit in
front of `/api/auth` and `/api/presets` for extra protection.

## Install (plug and play)

Grab a prebuilt `stpreseteditor-local-<version>.vsix` from this folder if one is
committed on your branch, or build it from source with `npm run package:ext`
(see [Build the .vsix](#build-the-vsix-maintainers) below), which produces
`extension/stpreseteditor-local-<version>.vsix`. Install it once:

1. In Cursor/VSCode, open the **Extensions** panel (square icon in the left bar,
   or `Ctrl/Cmd+Shift+X`).
2. Click the **`…`** menu at the top of that panel → **Install from VSIX…**.
3. Pick the `.vsix` file. When prompted, **Reload/Restart**.

That's it — no building, no F5. To use it:

- Open the folder with your presets (your SillyTavern
  `…/data/<user>/OpenAI Settings/` folder, or any folder with preset `.json`s).
- **Right-click a `.json` → "Open in STPresetEditor"**, or open the file and
  click the **pencil icon** in the top-right of the editor.

Edits autosave (~1s after you stop) back to that file; a **"✓ Preset saved …"**
note appears in the status bar. Tip: try a _copy_ of a preset first.

## The ST Presets view (folder workspace)

The Explorer sidebar gains an **ST Presets** panel listing every `.json` in the
open folder that parses as a SillyTavern preset (an object with a `prompts`
array; `node_modules` is always skipped, glob configurable via
`stpe.presetGlob`). From the panel you can **open, create, duplicate, rename,
and delete** presets — delete moves the file to the trash after a confirm.

With cloud sync configured you can additionally run **"Link folder to cloud
library"** (panel `…` menu). That writes a `.stpe-library.json` mapping at the
folder root and keeps the folder and your cloud library in sync both ways:

- local edits **push**, cloud edits **pull**, and if both sides changed you get
  a per-file **Keep local / Keep cloud** choice — nothing is overwritten
  silently, and nothing is ever deleted by sync;
- each file shows its state in the panel: ✓ synced, ↑ pending, ⚠ conflict,
  ☁ cloud-only (use **"Download missing presets"** to materialise those);
- sync runs when an editor panel is open (every ~30s and on file changes), or
  on demand via **"Sync folder with cloud library"**.

Commit `.stpe-library.json` if the whole folder should stay linked for every
clone, or add it to `.gitignore` to keep the link machine-local.

## Build the .vsix (maintainers)

From the **repository root**:

```bash
npm install
npm run package:ext     # builds the UI, then packages extension/*.vsix
```

The UI is the same Vue app, built with `base: './'` (see
`../vite.config.webview.js`) into `media/`; `extension.js` rewrites asset URLs to
webview URIs and applies a nonce-based Content-Security-Policy.

## Develop (live, no packaging)

Open the **`extension/` folder** in Cursor and press **F5** (Run → Start
Debugging) to launch an Extension Development Host with the extension loaded.
Re-run `npm run build:webview` and "Developer: Reload Webviews" after UI changes.

## How it works

```
extension.js (Node host)            media/ (built Vue SPA)
  reads/writes the .json   ◄─ postMessage ─►  src/stores/localBridge.js
  { type: 'load' / 'save' }                    parseFromJson / finalJson
```
