# STPresetEditor — Local Files (extension)

Edit SillyTavern presets straight from local files using the full STPresetEditor
UI, inside Cursor/VSCode. This is **phase M0 + M1** of `../EXTENSION_PLAN.md`:
open a `.json` preset → edit in the rich UI → it saves back to the same file.

> Not yet included (later phases): the preset-library tree (M2), live
> SillyTavern reload (M3), and Cloudflare cloud sync inside the extension (M2c).

## Build + run (development)

From the **repository root**:

```bash
npm install
npm run build:webview      # builds the Vue UI into extension/media/
```

Then run the extension:

1. Open the **`extension/` folder** in Cursor/VSCode (File → Open Folder).
2. Press **F5** (Run → Start Debugging). A second window opens:
   **[Extension Development Host]**.
3. In that window, open a folder containing SillyTavern presets — e.g. your
   `…/data/<user>/OpenAI Settings/` folder, or any folder with a preset `.json`.
4. **Right-click a `.json`** in the Explorer → **Open in STPresetEditor**
   (or open the file and run the command from the Command Palette).

The preset opens in the STPresetEditor UI. Edits autosave (~0.8s after you stop)
back to that same file; a **"✓ Preset saved …"** indicator appears in the status
bar on each write.

## How it works

```
extension.js (Node host)            media/ (built Vue SPA)
  reads/writes the .json   ◄─ postMessage ─►  src/stores/localBridge.js
  { type: 'load' / 'save' }                    parseFromJson / finalJson
```

`base: './'` (see `../vite.config.webview.js`) makes the build use relative
asset paths; `extension.js` rewrites them to webview URIs and applies a
nonce-based Content-Security-Policy.

## Rebuilding after UI changes

Re-run `npm run build:webview`, then reload the webview (close/reopen the preset,
or "Developer: Reload Webviews" in the dev-host window).
