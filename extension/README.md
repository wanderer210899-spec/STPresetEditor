# STPresetEditor — Local Files (extension)

Edit SillyTavern presets straight from local files using the full STPresetEditor
UI, inside Cursor/VSCode. Open a `.json` preset → edit in the rich UI → it saves
back to the same file automatically.

> Phase M0 + M1 + M2c of `../EXTENSION_PLAN.md`. Not yet included: the
> preset-library sidebar (M2) and live SillyTavern reload (M3).

## Cloud sync (optional, opt-in)

Cloud sync is **off until you point it at your own deployment** — the extension
has no built-in endpoint and contacts no server until you configure one. Each
person uses their **own** Cloudflare Worker (one-click deploy + a `SYNC_PASSWORD`
secret; see the project README), so nobody's data is shared by accident.

To turn it on:

1. **Settings → Extensions → `stpe.cloudUrl`** → paste your Worker's
   `https://<your-worker>.workers.dev/api/presets` URL.
2. In the editor's **Settings → Cloud sync**, enter the **same passphrase** you
   use on your phone/web app.

Then:

- On edit, the PC pushes the **current preset** to your cloud — your phone's
  saved library is never overwritten (the host does a safe read-merge-write of
  only the current-preset fields).
- To bring a preset you edited on your phone down to the PC, click
  **"☁ Pull preset"** in the status bar (or run **STPresetEditor: Pull preset
  from cloud**). It loads into the editor and saves to the open file.

Security notes: traffic is HTTPS and authenticated by your passphrase
(`X-Sync-Key`); the Worker fails closed without it. Use a long, random
passphrase (the Worker has no built-in rate limiting) and consider Cloudflare
Access or a WAF rate-limit in front of `/api/presets` for extra protection.

## Install (plug and play)

You're given a file named `stpreseteditor-local-<version>.vsix`. Install it once:

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
